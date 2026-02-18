from denied_sdk import Action, CheckRequest, DeniedClient, Resource, Subject

client = DeniedClient()

# Example 1: Simple check
result = client.check(
    subject_type="user",
    subject_id="alice",
    resource_type="document",
    resource_id="secret",
    action="read",
)
print(f"Decision: {result.decision}")

# Example 2: Check with additional properties
result = client.check(
    subject_type="user",
    subject_id="alice",
    resource_type="document",
    resource_id="secret",
    subject_properties={"role": "admin"},
    resource_properties={"classification": "secret"},
    action="write",
)
print(f"Decision: {result.decision}, Reason: {result.context.reason}")

# Example 3: Bulk check
requests = [
    CheckRequest(
        subject=Subject(type="user", id="alice"),
        resource=Resource(type="document", id="1"),
        action=Action(name="read"),
    ),
    CheckRequest(
        subject=Subject(type="user", id="bob", properties={"role": "viewer"}),
        resource=Resource(type="document", id="1", properties={"visibility": "public"}),
        action=Action(name="access"),
    ),
]
results = client.bulk_check(requests)
for i, result in enumerate(results):
    print(f"Check {i + 1}: {result.decision}")
