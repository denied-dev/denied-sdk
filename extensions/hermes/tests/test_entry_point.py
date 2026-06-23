"""Guards the packaging boundary that the unit tests cannot see.

The rest of the suite imports ``register`` directly, so it passes even when the
shipped entry point is broken. These tests instead resolve the plugin exactly
the way Hermes' loader (``hermes_cli/plugins.py``) does:

    module = entry_point.load()
    register_fn = getattr(module, "register", None)

A ``module:attr`` entry point (e.g. ``denied_hermes.plugin:register``) makes
``ep.load()`` return the *function*, so the ``getattr`` above finds nothing and
Hermes logs ``Plugin 'denied' has no register() function`` and silently skips
hook registration. These tests fail on that form and pass once the entry point
points at the module.
"""

from __future__ import annotations

import importlib.metadata

ENTRY_POINT_GROUP = "hermes_agent.plugins"
ENTRY_POINT_NAME = "denied"


def _denied_entry_point() -> importlib.metadata.EntryPoint:
    eps = importlib.metadata.entry_points().select(group=ENTRY_POINT_GROUP)
    matches = [ep for ep in eps if ep.name == ENTRY_POINT_NAME]
    assert matches, (
        f"No '{ENTRY_POINT_NAME}' entry point found in group "
        f"'{ENTRY_POINT_GROUP}'. Install the plugin (uv sync / pip install -e) "
        "so its entry-point metadata is present before running this test."
    )
    return matches[0]


def test_entry_point_targets_a_module_not_an_attribute() -> None:
    """The value must be ``module`` form, never ``module:attr``.

    ``EntryPoint.attr`` is ``None`` only when no ``:attr`` suffix is present,
    which is exactly what Hermes' loader requires.
    """
    ep = _denied_entry_point()
    assert ep.attr is None, (
        f"Entry point must point at a module so ep.load() returns the module, "
        f"but got the module:attr form '{ep.value}'. Drop the ':...' suffix."
    )


def test_loader_contract_resolves_register_callable() -> None:
    """Replicate Hermes' load + register lookup end to end."""
    ep = _denied_entry_point()
    loaded = ep.load()  # Hermes treats this return value as the module
    register_fn = getattr(loaded, "register", None)
    assert callable(register_fn), (
        "ep.load() must resolve to a module exposing a callable register(); "
        f"Hermes' getattr(module, 'register', None) got {register_fn!r} "
        f"from {loaded!r}."
    )
