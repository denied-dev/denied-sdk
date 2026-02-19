from typing import Any

from pydantic import BaseModel, Field, field_validator


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


SubjectLike = Subject | dict[str, Any] | str
ResourceLike = Resource | dict[str, Any] | str
ActionLike = Action | dict[str, Any] | str


class CheckRequest(BaseModel):
    """Request to check authorization following Authzen specification."""

    subject: Subject = Field(..., description="The subject performing the action")
    action: Action = Field(..., description="The action being performed")
    resource: Resource = Field(..., description="The resource being acted on")
    context: dict[str, Any] | None = Field(
        default=None, description="Additional context for the authorization check"
    )

    @field_validator("subject", mode="before")
    @classmethod
    def coerce_subject(cls, v: SubjectLike) -> Subject:
        if isinstance(v, Subject):
            return v
        if isinstance(v, dict):
            return Subject.model_validate(v)
        if "://" not in v:
            msg = f"Invalid subject string '{v}': expected format 'type://id'"
            raise ValueError(msg)
        entity_type, entity_id = v.split("://", 1)
        return Subject(type=entity_type, id=entity_id)

    @field_validator("resource", mode="before")
    @classmethod
    def coerce_resource(cls, v: ResourceLike) -> Resource:
        if isinstance(v, Resource):
            return v
        if isinstance(v, dict):
            return Resource.model_validate(v)
        if "://" not in v:
            msg = f"Invalid resource string '{v}': expected format 'type://id'"
            raise ValueError(msg)
        entity_type, entity_id = v.split("://", 1)
        return Resource(type=entity_type, id=entity_id)

    @field_validator("action", mode="before")
    @classmethod
    def coerce_action(cls, v: ActionLike) -> Action:
        if isinstance(v, Action):
            return v
        if isinstance(v, dict):
            return Action.model_validate(v)
        return Action(name=v)


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
