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
    principal_uri="user:alice",
    resource_uri="document:secret",
    action="read"
)

print(f"Allowed: {result.allowed}")
if result.reason:
    print(f"Reason: {result.reason}")
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

Check whether a principal has permissions to perform an action on a resource.

**Parameters:**

- `principal_uri` (str, optional): The identifier of the principal
- `resource_uri` (str, optional): The identifier of the resource
- `principal_attributes` (dict, optional): The attributes of the principal
- `resource_attributes` (dict, optional): The attributes of the resource
- `action` (str, optional): The action to check (default: "access")

**Returns:** `CheckResponse` with `allowed` (bool) and optional `reason` (str)

**Examples:**

```python
# Check with URIs
result = client.check(
    principal_uri="user:alice",
    resource_uri="document:123",
    action="read"
)

# Check with attributes
result = client.check(
    principal_attributes={"role": "admin"},
    resource_attributes={"type": "document", "classification": "secret"},
    action="write"
)

# Mix URIs and attributes
result = client.check(
    principal_uri="user:bob",
    resource_attributes={"type": "public"},
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
from denied_sdk import CheckRequest, PrincipalCheck, ResourceCheck, EntityType

requests = [
    CheckRequest(
        principal=PrincipalCheck(uri="user:alice", attributes={}),
        resource=ResourceCheck(uri="document:1", attributes={}),
        action="read"
    ),
    CheckRequest(
        principal=PrincipalCheck(uri=None, attributes={"role": "viewer"}),
        resource=ResourceCheck(uri=None, attributes={"type": "public"}),
        action="access"
    ),
]

results = client.bulk_check(requests)
for result in results:
    print(f"Allowed: {result.allowed}")
```

## Types

### EntityType

Enum for entity types:

- `EntityType.Principal`: Represents a principal (user, service, etc.)
- `EntityType.Resource`: Represents a resource

### CheckRequest

Authorization check request with:

- `principal`: PrincipalCheck
- `resource`: ResourceCheck
- `action`: str

### CheckResponse

Authorization check response with:

- `allowed`: bool
- `reason`: str | None

## Requirements

- Python >= 3.10
- httpx >= 0.28.1

## License

Apache-2.0
