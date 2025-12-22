"""Integration tests against real Denied endpoint.

Expected Rego Policy:
```rego
# User policy
allow {
    input.principal.attributes.role == "user"
    input.resource.attributes.scope == "user"
    input.action == "read"
}

# Admin policy
allow {
    input.principal.attributes.role == "admin"
    input.action == "read"
    allowed_scopes := ["user", "admin"]
    input.resource.attributes.scope == allowed_scopes[_]
}
```

Setup:
   export DENIED_URL='https://app.denied.dev/pdp/123'
   export DENIED_API_KEY='your-denied-api-key'

Run:
   uv run pytest tests/test_real_endpoint.py -v
"""

import os

import pytest

from denied_sdk import DeniedClient


@pytest.fixture
def client():
    """Create a DeniedClient with real endpoint from env vars."""
    # Load .env file inside fixture to avoid polluting other tests during collection
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    url = os.getenv("DENIED_URL")
    api_key = os.getenv("DENIED_API_KEY")

    if not url or not api_key:
        pytest.skip("DENIED_URL and DENIED_API_KEY must be set")

    with DeniedClient(url=url, api_key=api_key) as client:
        yield client


def test_alice_user_read_user_scope(client):
    """Test alice (role=user) reading user-scoped resource."""
    response = client.check(
        principal_uri="user:alice",
        principal_attributes={"role": "user"},
        resource_uri="tool:github_get_issues",
        resource_attributes={"scope": "user"},
        action="read",
    )

    print(f"\nAlice result: allowed={response.allowed}, reason={response.reason}")


def test_dude_user_read_user_scope(client):
    """Test dude (role=user) reading user-scoped resource - dude doesn't exist in DB."""
    response = client.check(
        principal_uri="user:dude",
        principal_attributes={"role": "user"},
        resource_uri="tool:github_get_issues",
        resource_attributes={"scope": "user"},
        action="read",
    )

    print(f"\nDude result: allowed={response.allowed}, reason={response.reason}")
