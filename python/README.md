# Denied SDK for Python

A lightweight Python SDK for the Denied authorization platform.

## Installation

```bash
uv add denied-sdk
```

Or with pip:

```bash
pip install denied-sdk
```

## Quick Start

```python
from denied_sdk import DeniedClient

client = DeniedClient(api_key="your-api-key")

result = client.check(
    subject="user://alice",
    action="read",
    resource="document://secret",
)

print(f"Decision: {result.decision}")
print(f"Reason: {result.context.reason}")
```

## Configuration

The SDK can be configured using constructor parameters or environment variables:

- **URL**: `url` parameter or `DENIED_URL` environment variable (default: `https://api.denied.dev`)
- **API Key**: `api_key` parameter or `DENIED_API_KEY` environment variable

```python
# Using environment variables
import os

os.environ["DENIED_URL"] = "https://example.denied.dev"
os.environ["DENIED_API_KEY"] = "your-api-key"
client = DeniedClient()

# Or pass directly to constructor:
client = DeniedClient(
    url="https://example.denied.dev",
    api_key="your-api-key",
)
```

## API Reference

### `check()`

Check whether a subject has permissions to perform an action on a resource.

**Parameters:**

- `subject` (Subject | dict | str, **required**): The subject performing the action.
  - `Subject` object: `Subject(type="user", id="alice", properties={"role": "admin"})`
  - dict: `{"type": "user", "id": "alice", "properties": {"role": "admin"}}`
  - URI string: `"user://alice"` (parsed as `type://id`)
- `action` (Action | dict | str, **required**): The action to check.
  - `Action` object: `Action(name="read", properties={"scope": "full"})`
  - dict: `{"name": "read", "properties": {"scope": "full"}}`
  - string: `"read"`
- `resource` (Resource | dict | str, **required**): The resource being acted on.
  - `Resource` object: `Resource(type="document", id="123", properties={"visibility": "public"})`
  - dict: `{"type": "document", "id": "123"}`
  - URI string: `"document://123"` (parsed as `type://id`)
- `context` (dict, optional): Additional context for the authorization check.

**Returns:** `CheckResponse` with `decision` (bool) and `context` (`CheckResponseContext`)

**Examples:**

```python
from denied_sdk import Action, DeniedClient, Resource, Subject

client = DeniedClient(api_key="your-api-key")

# Style 1: URI string shorthand — simplest for quick scripts
result = client.check(
    subject="user://alice",
    action="read",
    resource="document://123",
)

# Style 2: Dicts — convenient for JSON-derived or dynamic data
result = client.check(
    subject={"type": "user", "id": "alice", "properties": {"role": "admin"}},
    action={"name": "read"},
    resource={"type": "document", "id": "123", "properties": {"classification": "secret"}},
)

# Style 3: Typed objects — full IDE support and Pydantic validation
result = client.check(
    subject=Subject(type="user", id="alice", properties={"role": "admin"}),
    action=Action(name="read"),
    resource=Resource(type="document", id="123", properties={"classification": "secret"}),
)

# With additional context
result = client.check(
    subject="user://alice",
    action="read",
    resource="document://123",
    context={"ip": "192.168.1.1"},
)
```

### `bulk_check()`

Perform multiple permission checks in a single request.

**Parameters:**

- `check_requests` (list[CheckRequest]): List of check requests

**Returns:** `list[CheckResponse]`

**Example:**

```python
from denied_sdk import Action, CheckRequest, DeniedClient, Resource, Subject

client = DeniedClient(api_key="your-api-key")

requests = [
    CheckRequest(
        subject=Subject(type="user", id="alice"),
        action=Action(name="read"),
        resource=Resource(type="document", id="1"),
    ),
    CheckRequest(
        subject=Subject(type="user", id="bob", properties={"role": "viewer"}),
        action=Action(name="access"),
        resource=Resource(type="document", id="1", properties={"visibility": "public"}),
    ),
]

results = client.bulk_check(requests)
for result in results:
    print(f"Decision: {result.decision}")
```

## Types

### CheckRequest

```python
CheckRequest(
    subject=Subject(...),   # or dict or "type://id" string
    action=Action(...),     # or dict or string
    resource=Resource(...), # or dict or "type://id" string
    context={"ip": "..."},  # optional
)
```

The `subject`, `action`, and `resource` fields accept the same flexible union types as the `check()` method.

#### Subject / Resource

```python
Subject(type="user", id="alice", properties={"role": "admin"})
Resource(type="document", id="123", properties={"visibility": "public"})
```

Both accept the same fields:

- `type` (str, required): Entity type
- `id` (str, required): Unique identifier scoped to the type
- `properties` (dict, optional): Additional properties

#### Action

```python
Action(name="read", properties={"scope": "full"})
```

- `name` (str, required): Action name
- `properties` (dict, optional): Additional properties

### CheckResponse

- `decision` (bool): Whether the action is allowed
- `context` (`CheckResponseContext`, optional):
  - `reason` (str | None): Reason for the decision
  - `rules` (list[str] | None): Rules that triggered the decision

## Async Client

An async client is also available:

```python
from denied_sdk import AsyncDeniedClient

async with AsyncDeniedClient(api_key="your-api-key") as client:
    result = await client.check(
        subject="user://alice",
        action="read",
        resource="document://secret",
    )
    print(f"Decision: {result.decision}")
```

## Requirements

- Python >= 3.10
- httpx >= 0.28.1

## License

Apache-2.0
