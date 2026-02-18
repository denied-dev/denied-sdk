# Denied SDK for Python

A lightweight Python SDK for the Denied authorization platform.

## Installation

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

print(result.decision)        # True or False
print(result.context.reason)  # Optional reason string
```

## Configuration

|              | Parameter | Environment variable | Default                  |
| ------------ | --------- | -------------------- | ------------------------ |
| **Base URL** | `url`     | `DENIED_URL`         | `https://api.denied.dev` |
| **API Key**  | `api_key` | `DENIED_API_KEY`     | -                        |

Configure the SDK by instancing the `DeniedClient` with the desired parameters.

```python
# with constructor parameters
client = DeniedClient(
    url="https://example.denied.dev",
    api_key="your-api-key",
)

# or with environment variables
client = DeniedClient()
```

## API Reference

### `check()`

Check whether a subject has permissions to perform an action on a resource.

**Signature:**

```python
client.check(subject, action, resource, context=None) -> CheckResponse
```

**Arguments:**

- `subject` — `Subject` object, `dict`, or `"type://id"` string
- `action` — `Action` object, `dict`, or plain string
- `resource` — `Resource` object, `dict`, or `"type://id"` string
- `context` — optional `dict` of additional context

**Examples:**

```python
from denied_sdk import Action, Resource, Subject

# URI string shorthand — simplest
result = client.check(subject="user://alice", action="read", resource="document://123")

# Typed objects — full IDE support and Pydantic validation
result = client.check(
    subject=Subject(type="user", id="alice", properties={"role": "admin"}),
    action=Action(name="read"),
    resource=Resource(type="document", id="123"),
    context={"ip": "192.168.1.1"},
)
```

### `bulk_check()`

Perform multiple authorization checks in a single request.

**Signature:**

```python
client.bulk_check(check_requests: list[CheckRequest]) -> list[CheckResponse]
```

**Examples:**

```python
from denied_sdk import Action, CheckRequest, Resource, Subject

results = client.bulk_check([
    CheckRequest(
        subject=Subject(type="user", id="alice"),
        action=Action(name="read"),
        resource=Resource(type="document", id="1"),
    ),
    CheckRequest(
        subject=Subject(type="user", id="bob"),
        action=Action(name="write"),
        resource=Resource(type="document", id="1"),
    ),
])
```

## Types

**`Subject` / `Resource`** — `type: str`, `id: str`, `properties: dict` (optional)
**`Action`** — `name: str`, `properties: dict` (optional)
**`CheckRequest`** — `subject`, `action`, `resource`, `context: dict` (optional)
**`CheckResponse`** — `decision: bool`, `context` (optional: `reason: str`, `rules: list[str]`)

## Async Client

```python
from denied_sdk import AsyncDeniedClient

async with AsyncDeniedClient(api_key="your-api-key") as client:
    result = await client.check(
        subject="user://alice",
        action="read",
        resource="document://secret",
    )
```

## Requirements

Python >= 3.10

## License

Apache-2.0
