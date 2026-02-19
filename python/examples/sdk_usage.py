from denied_sdk import Action, CheckRequest, DeniedClient, Resource, Subject

client = DeniedClient()

# 1.1. Single check / Simple URI string shorthand
result = client.check(
    subject="user://alice",
    action="read",
    resource="document://secret",
)
print(f"Decision: {result.decision}")

# 1.2. Single check / Objects as dicts
result = client.check(
    subject={"type": "user", "id": "alice", "properties": {"role": "admin"}},
    action={"name": "write"},
    resource={
        "type": "document",
        "id": "secret",
        "properties": {"classification": "secret"},
    },
)
print(f"Decision: {result.decision}")

# 1.3. Single check / Typed objects
result = client.check(
    subject=Subject(type="user", id="alice", properties={"role": "admin"}),
    action=Action(name="write"),
    resource=Resource(
        type="document", id="secret", properties={"classification": "secret"}
    ),
)
print(f"Decision: {result.decision}")

# 2. Multiple bulk checks
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
for i, result in enumerate(results):
    print(f"Check {i + 1}: {result.decision}")
