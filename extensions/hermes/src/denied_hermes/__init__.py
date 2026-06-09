"""Denied authorization plugin for Hermes Agent."""

from .plugin import DeniedHermesPlugin, register

__all__ = ["DeniedHermesPlugin", "register"]
