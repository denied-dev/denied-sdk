from dataclasses import dataclass, field, asdict
from typing import Any

from .enums import EntityType


@dataclass
class EntityCheck:
    """Base class for entity checks in authorization requests."""

    uri: str | None
    attributes: dict[str, Any]
    type: EntityType


@dataclass
class PrincipalCheck(EntityCheck):
    """Principal entity in an authorization check."""

    type: EntityType = field(default=EntityType.Principal, init=False)


@dataclass
class ResourceCheck(EntityCheck):
    """Resource entity in an authorization check."""

    type: EntityType = field(default=EntityType.Resource, init=False)


@dataclass
class CheckRequest:
    """Request to check authorization for a principal on a resource."""

    principal: PrincipalCheck
    resource: ResourceCheck
    action: str

    def model_dump(self) -> dict[str, Any]:
        """
        Serialize the check request to a dictionary for JSON encoding.

        Returns
        -------
        dict[str, Any]
            Dictionary representation of the check request.
        """
        return {
            "principal": asdict(self.principal),
            "resource": asdict(self.resource),
            "action": self.action,
        }


@dataclass
class CheckResponse:
    """Response from an authorization check."""

    allowed: bool
    reason: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CheckResponse":
        """
        Create a CheckResponse from a dictionary.

        Parameters
        ----------
        data : dict[str, Any]
            Dictionary containing response data.

        Returns
        -------
        CheckResponse
            The deserialized check response.
        """
        return cls(allowed=data["allowed"], reason=data.get("reason"))
