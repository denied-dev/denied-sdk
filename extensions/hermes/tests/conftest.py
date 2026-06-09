from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON_SRC = REPO_ROOT / "python" / "src"
PLUGIN_SRC = REPO_ROOT / "extensions" / "hermes" / "src"

for path in (PYTHON_SRC, PLUGIN_SRC):
    sys.path.insert(0, str(path))
