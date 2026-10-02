"""Make the repository folder importable as the package terralingua_launcher."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

if "terralingua_launcher" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "terralingua_launcher", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules["terralingua_launcher"] = package
    spec.loader.exec_module(package)
