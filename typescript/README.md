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

Check if a subject has permission to perform an action on a resource:

```typescript
async function checkPermission() {
  const response = await client.check({
    subjectType: "user",
    subjectId: "admin",
    subjectProperties: { role: "admin" },
    resourceType: "document",
    resourceId: "confidential-doc",
    resourceProperties: { classification: "confidential" },
    action: "read",
  });

  console.log(`Decision: ${response.decision}`);
  console.log(`Reason: ${response.context?.reason || "No reason"}`);
}
```

### Bulk Check

Perform multiple permission checks in a single request:

```typescript
import { CheckRequest } from "denied-sdk";

async function bulkCheckPermissions() {
  const requests: CheckRequest[] = [
    {
      subject: {
        type: "user",
        id: "alice",
        properties: { role: "editor" },
      },
      resource: {
        type: "document",
        id: "report",
        properties: { classification: "public" },
      },
      action: { name: "read" },
    },
    {
      subject: {
        type: "user",
        id: "bob",
        properties: { role: "viewer" },
      },
      resource: {
        type: "document",
        id: "report",
        properties: { classification: "confidential" },
      },
      action: { name: "write" },
    },
  ];

  const responses = await client.bulkCheck(requests);
  responses.forEach((response, index) => {
    console.log(`Check ${index + 1}: Decision = ${response.decision}`);
  });
}
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
check(options: CheckOptions): Promise<CheckResponse>
```

Check if a subject has permission to perform an action on a resource.

**Parameters:**

- `subjectType` (string): The type of the subject
- `subjectId` (string): The unique identifier of the subject scoped to the type
- `subjectProperties` (Record<string, unknown>, optional): Additional properties of the subject
- `resourceType` (string): The type of the resource
- `resourceId` (string): The unique identifier of the resource scoped to the type
- `resourceProperties` (Record<string, unknown>, optional): Additional properties of the resource
- `action` (string | Action, optional): The action to check (defaults to "access")

**Returns:** Promise<CheckResponse>

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

**Returns:** Promise<CheckResponse[]> - Array of check responses

## Types

### CheckRequest

```typescript
interface CheckRequest {
  subject: Subject;
  resource: Resource;
  action: Action;
  context?: Record<string, unknown>;
}
```

### CheckResponse

```typescript
interface CheckResponse {
  decision: boolean;
  context?: CheckResponseContext;
}
```

## Examples

For more examples, see the [examples](./examples) directory.

## License

Apache-2.0
