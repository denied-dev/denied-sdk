"""Hermes local-plugin entrypoint for Denied authorization."""

import sys
from pathlib import Path

_SRC = Path(__file__).parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from denied_hermes.plugin import register  # noqa: E402

__all__ = ["register"]
