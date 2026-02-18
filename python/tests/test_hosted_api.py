"""Integration tests against real Denied endpoint.

Expected Rego Policy:
```rego
# User policy
allow {
    input.subject.properties.role == "user"
    input.resource.properties.scope == "user"
    input.action.name == "read"
}

# Admin policy
allow {
    input.subject.properties.role == "admin"
    input.action.name == "read"
    allowed_scopes := ["user", "admin"]
    input.resource.properties.scope == allowed_scopes[_]
}
```

Setup:
   export DENIED_URL='https://api.test.denied.dev'
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
        subject_type="user",
        subject_id="alice",
        subject_properties={"role": "user"},
        resource_type="tool",
        resource_id="github_get_issues",
        resource_properties={"scope": "user"},
        action="read",
    )

    print(
        f"\nAlice result: decision={response.decision}, reason={response.context.reason}"
    )


def test_dude_user_read_user_scope(client):
    """Test dude (role=user) reading user-scoped resource - dude doesn't exist in DB."""
    response = client.check(
        subject_type="user",
        subject_id="dude",
        subject_properties={"role": "user"},
        resource_type="tool",
        resource_id="github_get_issues",
        resource_properties={"scope": "user"},
        action="read",
    )

    print(
        f"\nDude result: decision={response.decision}, reason={response.context.reason}"
    )
