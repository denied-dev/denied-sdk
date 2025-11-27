from enum import Enum


class EntityType(str, Enum):
    """Entity types in the Denied authorization system."""

    Resource = "resource"
    Principal = "principal"
