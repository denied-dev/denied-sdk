from denied_sdk import (
    CheckRequest,
    DeniedClient,
    PrincipalCheck,
    ResourceCheck,
)

# Initialize client
client = DeniedClient(url="http://localhost:8421")

# Example 1: Simple check with URIs
result = client.check(
    principal_uri="user:alice",
    resource_uri="document:secret",
    action="read",
)
print(f"Allowed: {result.allowed}")

# Example 2: Check with attributes
result = client.check(
    principal_attributes={"role": "admin"},
    resource_attributes={"type": "document"},
    action="write",
)
print(f"Allowed: {result.allowed}, Reason: {result.reason}")

# Example 3: Bulk check
requests = [
    CheckRequest(
        principal=PrincipalCheck(
            uri="user:alice",
            attributes={},
        ),
        resource=ResourceCheck(
            uri="document:1",
            attributes={},
        ),
        action="read",
    ),
    CheckRequest(
        principal=PrincipalCheck(
            uri=None,
            attributes={"role": "viewer"},
        ),
        resource=ResourceCheck(
            uri=None,
            attributes={"type": "public"},
        ),
        action="access",
    ),
]
results = client.bulk_check(requests)
for i, result in enumerate(results):
    print(f"Check {i + 1}: {result.allowed}")
