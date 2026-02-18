# Denied SDK for TypeScript

A lightweight TypeScript SDK for the Denied authorization platform.

## Installation

```bash
npm install denied-sdk
```

## Quick Start

```typescript
import { DeniedClient } from "denied-sdk";

const client = new DeniedClient({ apiKey: "your-api-key" });

const result = await client.check({
  subject: "user://alice",
  action: "read",
  resource: "document://secret",
});

console.log(result.decision); // true or false
console.log(result.context?.reason); // Optional reason string
```

## Configuration

|              | Parameter | Environment variable | Default                  |
| ------------ | --------- | -------------------- | ------------------------ |
| **Base URL** | `url`     | `DENIED_URL`         | `https://api.denied.dev` |
| **API Key**  | `apiKey`  | `DENIED_API_KEY`     | -                        |

Configure the SDK by instancing the `DeniedClient` with the desired parameters.

```typescript
// with constructor parameters
const client = new DeniedClient({
  url: "https://example.denied.dev",
  apiKey: "your-api-key",
});

// or with environment variables:
const client = new DeniedClient();
```

## API Reference

### `check()`

Check whether a subject has permissions to perform an action on a resource.

**Signature:**

```typescript
client.check({ subject, action, resource, context? }): Promise<CheckResponse>
```

**Arguments:**

- `subject` — `Subject` object or `"type://id"` string
- `action` — `Action` object or plain string
- `resource` — `Resource` object or `"type://id"` string
- `context` — optional `Record<string, unknown>` of additional context

**Examples:**

```typescript
// URI string shorthand — simplest
const result = await client.check({
  subject: "user://alice",
  action: "read",
  resource: "document://123",
});

// Typed objects
const result = await client.check({
  subject: { type: "user", id: "alice", properties: { role: "admin" } },
  action: { name: "read" },
  resource: { type: "document", id: "123" },
  context: { ip: "192.168.1.1" },
});
```

### `bulkCheck()`

Perform multiple authorization checks in a single request.

**Signature:**

```typescript
client.bulkCheck(requests: CheckRequest[]): Promise<CheckResponse[]>
```

**Examples:**

```typescript
const results = await client.bulkCheck([
  {
    subject: { type: "user", id: "alice" },
    action: { name: "read" },
    resource: { type: "document", id: "1" },
  },
  {
    subject: { type: "user", id: "bob" },
    action: { name: "write" },
    resource: { type: "document", id: "1" },
  },
]);
```

## Types

**`Subject` / `Resource`** — `type: string`, `id: string`, `properties?: Record<string, unknown>`
**`Action`** — `name: string`, `properties?: Record<string, unknown>`
**`CheckRequest`** — `subject`, `action`, `resource`, `context?: Record<string, unknown>`
**`CheckResponse`** — `decision: boolean`, `context?: { reason?: string; rules?: string[] }`

## License

Apache-2.0
