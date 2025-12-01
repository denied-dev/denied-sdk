from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from denied_sdk.enums.entity import EntityType


class EntityCheck(BaseModel):
    """Base class for entity checks in authorization requests."""

    uri: str | None = Field(
        default=None, description="Unique identifier for the entity"
    )
    attributes: dict[str, Any] | None = Field(
        default_factory=dict, description="Entity attributes"
    )
    type: EntityType = Field(..., description="Type of entity")

    @model_validator(mode="after")
    def either_uri_or_attributes(self) -> "EntityCheck":
        """Ensure either uri or non-empty attributes is provided."""
        if not self.uri and not self.attributes:
            message = "Either 'uri' or non-empty 'attributes' must be provided"
            raise ValueError(message)
        return self


class ResourceCheck(EntityCheck):
    """Resource entity in an authorization check."""

    type: Literal[EntityType.resource] = EntityType.resource


class PrincipalCheck(EntityCheck):
    """Principal entity in an authorization check."""

    type: Literal[EntityType.principal] = EntityType.principal


class CheckRequest(BaseModel):
    """Request to check authorization for a principal on a resource."""

    principal: PrincipalCheck = Field(
        ..., description="The principal performing the action"
    )
    resource: ResourceCheck = Field(..., description="The resource being acted on")
    action: str = Field(
        default="access", description="The action being performed on the resource"
    )


class CheckResponse(BaseModel):
    """Response from an authorization check."""

    allowed: bool = Field(..., description="Whether the action is allowed")
    reason: str | None = Field(None, description="The reason for the decision")
    rules: list[str] | None = Field(
        None, description="The rules that triggered the decision"
    )
