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

# Initialize the client
client = DeniedClient(api_key="your-api-key")

# Check authorization
result = client.check(
    subject_type="user",
    subject_id="alice",
    resource_type="document",
    resource_id="secret",
    action="read"
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

os.environ["DENIED_API_KEY"] = "your-api-key"

client = DeniedClient()

# To use a custom URL (e.g., self-hosted instance):
os.environ["DENIED_URL"] = "https://example.denied.dev"
client = DeniedClient()  # Will use custom URL

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

- `subject_type` (str, optional): The type of the subject
- `subject_id` (str, optional): The identifier of the subject
- `resource_type` (str, optional): The type of the resource
- `resource_id` (str, optional): The identifier of the resource
- `subject_properties` (dict, optional): The properties of the subject
- `resource_properties` (dict, optional): The properties of the resource
- `action` (str, optional): The action to check (default: "access")

**Returns:** `CheckResponse` with `decision` (bool) and `context` (`CheckResponseContext`)

**Examples:**

```python
# Check with type and id
result = client.check(
    subject_type="user",
    subject_id="alice",
    resource_type="document",
    resource_id="123",
    action="read"
)

# Check with properties
result = client.check(
    subject_type="user",
    subject_id="bob",
    resource_type="document",
    resource_id="123",
    resource_properties={"visibility": "public"},
    action="access"
)
```

### `bulk_check()`

Perform multiple permission checks in a single request.

**Parameters:**

- `check_requests` (list[CheckRequest]): List of check requests

**Returns:** `list[CheckResponse]`

**Example:**

```python
from denied_sdk import Action, CheckRequest, Subject, Resource

requests = [
    CheckRequest(
        subject=Subject(type="user", id="alice", properties={}),
        resource=Resource(type="document", id="1", properties={}),
        action=Action(name="read")
    ),
    CheckRequest(
        subject=Subject(type="user", id="bob", properties={"role": "viewer"}),
        resource=Resource(type="document", id="1", properties={"visibility": "public"}),
        action=Action(name="access")
    ),
]

results = client.bulk_check(requests)
for result in results:
    print(f"Decision: {result.decision}")
```

### CheckRequest

Authorization check request with:

- `subject`: Subject
- `resource`: Resource
- `action`: Action
- `context`: dict | None

### CheckResponse

Authorization check response with:

- `decision`: bool
- `context`: `CheckResponseContext`:
  - `reason`: str | None
  - `rules`: list[str] | None

## Requirements

- Python >= 3.10
- httpx >= 0.28.1

## License

Apache-2.0
