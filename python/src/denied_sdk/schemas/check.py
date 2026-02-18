from typing import Any

from pydantic import BaseModel, Field


class SubjectOrResourceBase(BaseModel):
    """Base class for subjects and resources following Authzen specification."""

    type: str = Field(..., description="Type of the entity")
    id: str = Field(..., description="Unique identifier scoped to the type")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Additional properties of the entity"
    )


class Subject(SubjectOrResourceBase):
    """Subject entity (user, service, etc.) in an authorization check."""


class Resource(SubjectOrResourceBase):
    """Resource entity (document, API, etc.) in an authorization check."""


class Action(BaseModel):
    """Action being performed in an authorization check."""

    name: str = Field(..., description="Name of the action")
    properties: dict[str, Any] | None = Field(
        default=None, description="Additional properties of the action"
    )


class CheckRequest(BaseModel):
    """Request to check authorization following Authzen specification."""

    subject: Subject = Field(..., description="The subject performing the action")
    resource: Resource = Field(..., description="The resource being acted on")
    action: Action = Field(..., description="The action being performed")
    context: dict[str, Any] | None = Field(
        default=None, description="Additional context for the authorization check"
    )


class CheckResponseContext(BaseModel):
    """Context information in an authorization response."""

    reason: str | None = Field(None, description="The reason for the decision")
    rules: list[str] | None = Field(
        None, description="The rules that triggered the decision"
    )


class CheckResponse(BaseModel):
    """Response from an authorization check following Authzen specification."""

    decision: bool = Field(..., description="Whether the action is allowed")
    context: CheckResponseContext | None = Field(
        None, description="Additional context about the decision"
    )
