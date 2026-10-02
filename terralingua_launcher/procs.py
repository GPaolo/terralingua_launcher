"""Child-process registry for launched simulations.

Each child gets its own session, so stopping it reaches every process it
started, and its output goes to a log file under <workdir>/logs/_launcher/.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from terralingua_launcher.store import slug

LOG_CHUNK = 64 * 1024


def _without_partial_char(data: bytes) -> bytes:
    """Drop a trailing incomplete UTF-8 sequence so the next read gets it whole."""
    for back in range(1, min(3, len(data)) + 1):
        lead = data[-back]
        if lead & 0xC0 == 0x80:  # a continuation byte: its lead byte is further back
            continue
        length = 2 if lead & 0xE0 == 0xC0 else 3 if lead & 0xF0 == 0xE0 else 4 if lead & 0xF8 == 0xF0 else 1
        return data[:-back] if length > back else data
    return data


@dataclass
class Proc:
    id: int
    label: str
    argv: list
    log_path: str
    popen: subprocess.Popen = field(repr=False)
    url: str | None = None
    started_at: float = field(default_factory=time.time)
    stop_requested: bool = False

    def status(self) -> str:
        rc = self.popen.poll()
        if rc is None:
            return "running"
        if self.stop_requested or rc in (-signal.SIGTERM, -signal.SIGKILL):
            return "stopped"
        return "finished" if rc == 0 else f"exited ({rc})"

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "cmd": shlex.join(self.argv),
            "status": self.status(),
            "returncode": self.popen.poll(),
            "started_at": self.started_at,
            "log_path": self.log_path,
            "url": self.url,
        }


class ProcRegistry:
    def __init__(self):
        self._procs: dict[int, Proc] = {}
        self._next_id = 1
        # endpoints run in FastAPI's threadpool; id allocation must be atomic
        self._lock = threading.Lock()

    def spawn(self, label: str, argv: list, cwd: Path, env: dict | None = None, url: str | None = None) -> Proc:
        """Start a child; an OSError means it could not start and leaves no log behind."""
        with self._lock:
            proc_id = self._next_id
            self._next_id += 1
        argv = [str(a) for a in argv]
        log_dir = Path(cwd) / "logs" / "_launcher"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        log_path = log_dir / f"{stamp}_{proc_id}_{slug(label)}.log"
        with open(log_path, "ab") as log_file:
            log_file.write((shlex.join(argv) + "\n\n").encode())
            log_file.flush()
            try:
                popen = subprocess.Popen(
                    argv,
                    cwd=str(cwd),
                    env=env,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError:
                log_path.unlink(missing_ok=True)
                raise
        proc = Proc(
            id=proc_id,
            label=label,
            argv=argv,
            log_path=str(log_path),
            popen=popen,
            url=url,
        )
        self._procs[proc.id] = proc
        return proc

    def get(self, proc_id: int) -> Proc | None:
        return self._procs.get(proc_id)

    def list(self) -> list[dict]:
        return [p.as_dict() for p in sorted(self._procs.values(), key=lambda p: -p.id)]

    def stop(self, proc_id: int, force: bool = False) -> bool:
        proc = self._procs.get(proc_id)
        if proc is None or proc.popen.poll() is not None:
            return False
        proc.stop_requested = True
        sig = signal.SIGKILL if force else signal.SIGTERM
        try:
            os.killpg(os.getpgid(proc.popen.pid), sig)
        except (ProcessLookupError, PermissionError):
            proc.popen.terminate()
        return True

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
                if proc.popen.poll() is None:
                    data = _without_partial_char(data)
                offset += len(data)
                text = data.decode("utf-8", errors="replace")
        except OSError:
            pass
        return {"offset": offset, "text": text, "status": proc.status()}
