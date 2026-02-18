# Denied SDK for TypeScript

This package allows you to integrate [Denied](https://github.com/denied-dev/denied-sdk) inside your TypeScript application, providing a client to interact with the Denied authorization server.

## Installation

Install the `denied-sdk` package via pnpm:

```bash
pnpm add denied-sdk
```

Or using npm:

```bash
npm install denied-sdk
```

## Usage

Create an instance of the `DeniedClient` class to interact with the Denied server.

```typescript
import { DeniedClient } from "denied-sdk";

const client = new DeniedClient({
  apiKey: "your-api-key-here",
});
```

### Environment Variables

You can also configure the client using environment variables:

- `DENIED_URL` - The base URL of the Denied server (default: `https://api.denied.dev`)
- `DENIED_API_KEY` - Your API key for authentication

If these are set, you can initialize the client without parameters:

```typescript
const client = new DeniedClient();
```

For custom or self-hosted instances, you can override the URL:

```typescript
const client = new DeniedClient({
  url: "https://example.denied.dev",
  apiKey: "your-api-key-here",
});
```

### Check Permissions

Check if a subject has permission to perform an action on a resource.

The `subject` and `resource` fields accept either a typed object or a `"type://id"` string. The `action` field accepts either a typed object or a plain string.

```typescript
// Style 1: URI string shorthand — simplest for quick scripts
const response = await client.check({
  subject: "user://alice",
  action: "read",
  resource: "document://secret",
});

// Style 2: Typed objects — full IDE support with properties
const response = await client.check({
  subject: { type: "user", id: "admin", properties: { role: "admin" } },
  action: { name: "read" },
  resource: {
    type: "document",
    id: "confidential-doc",
    properties: { classification: "confidential" },
  },
});

// With additional context
const response = await client.check({
  subject: "user://alice",
  action: "read",
  resource: "document://123",
  context: { ip: "192.168.1.1" },
});

console.log(`Decision: ${response.decision}`);
console.log(`Reason: ${response.context?.reason || "No reason"}`);
```

### Bulk Check

Perform multiple permission checks in a single request:

```typescript
import { CheckRequest } from "denied-sdk";

const requests: CheckRequest[] = [
  {
    subject: { type: "user", id: "alice", properties: { role: "editor" } },
    action: { name: "read" },
    resource: {
      type: "document",
      id: "report",
      properties: { classification: "public" },
    },
  },
  {
    subject: { type: "user", id: "bob", properties: { role: "viewer" } },
    action: { name: "write" },
    resource: {
      type: "document",
      id: "report",
      properties: { classification: "confidential" },
    },
  },
];

const responses = await client.bulkCheck(requests);
responses.forEach((response, index) => {
  console.log(`Check ${index + 1}: Decision = ${response.decision}`);
});
```

## API Reference

### DeniedClient

#### Constructor

```typescript
new DeniedClient(options?: DeniedClientOptions)
```

**Options:**

- `url` (string, optional): The base URL of the Denied server. Defaults to `process.env.DENIED_URL` or `"https://api.denied.dev"`
- `apiKey` (string, optional): The API key for authentication. Defaults to `process.env.DENIED_API_KEY`

#### Methods

##### check()

```typescript
check(options: {
  subject: SubjectLike;
  action: ActionLike;
  resource: ResourceLike;
  context?: Record<string, unknown>;
}): Promise<CheckResponse>
```

Check if a subject has permission to perform an action on a resource.

**Parameters:**

- `subject` (Subject | string, **required**): The subject performing the action. Either a `Subject` object `{ type, id, properties? }` or a `"type://id"` string.
- `action` (Action | string, **required**): The action to check. Either an `Action` object `{ name, properties? }` or a plain action name string.
- `resource` (Resource | string, **required**): The resource being acted on. Either a `Resource` object `{ type, id, properties? }` or a `"type://id"` string.
- `context` (Record<string, unknown>, optional): Additional context for the authorization check.

**Returns:** `Promise<CheckResponse>`

- `decision` (boolean): Whether the action is allowed
- `context` (CheckResponseContext, optional): Context for the decision
  - `reason` (string, optional): Reason for the decision
  - `rules` (string[], optional): Rules that triggered the decision

##### bulkCheck()

```typescript
bulkCheck(requests: CheckRequest[]): Promise<CheckResponse[]>
```

Perform multiple permission checks in a single request.

**Parameters:**

- `requests` (CheckRequest[]): Array of check requests

**Returns:** `Promise<CheckResponse[]>` - Array of check responses

## Types

### CheckRequest

```typescript
interface CheckRequest {
  subject: Subject;
  action: Action;
  resource: Resource;
  context?: Record<string, unknown>;
}
```

#### Subject / Resource

```typescript
interface Subject | Resource {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}
```

#### Action

```typescript
interface Action {
  name: string;
  properties?: Record<string, unknown>;
}
```

### CheckResponse

```typescript
interface CheckResponse {
  decision: boolean;
  context?: CheckResponseContext;
}
```

#### CheckResponseContext

```typescript
interface CheckResponseContext {
  reason?: string;
  rules?: string[];
}
```

## Examples

For more examples, see the [examples](./examples) directory.

## License

Apache-2.0
