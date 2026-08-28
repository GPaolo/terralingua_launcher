"""Child-process registry: the simulation and the viz dashboard.

Each child gets its own session (killpg reaches ffmpeg and friends) and its
stdout/stderr appended to a log file under <repo>/logs/_launcher/, which the
dashboard skips (it only lists dirs holding a params.json).
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

LOG_CHUNK = 64 * 1024


@dataclass
class Proc:
    id: int
    kind: str  # "sim" | "viz"
    label: str
    argv: list
    cwd: str
    log_path: str
    popen: subprocess.Popen = field(repr=False)
    started_at: float = field(default_factory=time.time)

    def status(self) -> str:
        rc = self.popen.poll()
        if rc is None:
            return "running"
        clean = rc in (0, -signal.SIGTERM, -signal.SIGKILL)
        return "stopped" if clean else f"exited ({rc})"

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "cmd": " ".join(map(str, self.argv)),
            "status": self.status(),
            "returncode": self.popen.poll(),
            "started_at": self.started_at,
            "log_path": self.log_path,
        }


class ProcRegistry:
    def __init__(self):
        self._procs: dict[int, Proc] = {}
        self._next_id = 1
        # endpoints run in FastAPI's threadpool; id allocation must be atomic
        self._lock = threading.Lock()

    def spawn(self, kind: str, label: str, argv: list, cwd: Path) -> Proc:
        with self._lock:
            proc_id = self._next_id
            self._next_id += 1
        log_dir = Path(cwd) / "logs" / "_launcher"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:60]
        log_path = log_dir / f"{stamp}_{kind}_{safe}.log"
        log_file = open(log_path, "ab")
        log_file.write((" ".join(map(str, argv)) + "\n\n").encode())
        log_file.flush()
        popen = subprocess.Popen(
            [str(a) for a in argv],
            cwd=str(cwd),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        log_file.close()  # the child holds its own copy of the fd
        proc = Proc(
            id=proc_id,
            kind=kind,
            label=label,
            argv=[str(a) for a in argv],
            cwd=str(cwd),
            log_path=str(log_path),
            popen=popen,
        )
        self._procs[proc.id] = proc
        return proc

    def get(self, proc_id: int) -> Proc | None:
        return self._procs.get(proc_id)

    def list(self) -> list[dict]:
        return [p.as_dict() for p in sorted(self._procs.values(), key=lambda p: -p.id)]

    def running(self, kind: str | None = None) -> list[Proc]:
        return [
            p
            for p in self._procs.values()
            if p.popen.poll() is None and (kind is None or p.kind == kind)
        ]

    def stop(self, proc_id: int, force: bool = False) -> bool:
        proc = self._procs.get(proc_id)
        if proc is None or proc.popen.poll() is not None:
            return False
        sig = signal.SIGKILL if force else signal.SIGTERM
        try:
            os.killpg(os.getpgid(proc.popen.pid), sig)
        except (ProcessLookupError, PermissionError):
            proc.popen.terminate()
        return True

    def stop_all(self):
        for p in self.running():
            self.stop(p.id)

    def read_log(self, proc_id: int, offset: int = 0) -> dict:
        proc = self._procs.get(proc_id)
        if proc is None:
            return {"offset": offset, "text": "", "status": "unknown"}
        text = ""
        try:
            with open(proc.log_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                if offset > size:  # truncated/rotated: start over
                    offset = 0
                if size - offset > LOG_CHUNK and offset == 0:
                    offset = size - LOG_CHUNK  # first read: tail, don't replay all
                f.seek(offset)
                data = f.read(LOG_CHUNK)
                offset += len(data)
                text = data.decode("utf-8", errors="replace")
        except OSError:
            pass
        return {"offset": offset, "text": text, "status": proc.status()}
