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
  uuid: "your-uuid-here",
  apiKey: "your-api-key-here",
});
```

### Environment Variables

You can also configure the client using environment variables:

- `DENIED_URL` - The base URL of the Denied server (default: `https://api.denied.dev`)
- `DENIED_UUID` - Your UUID of the decision node to use
- `DENIED_API_KEY` - Your API key for authentication

If these are set, you can initialize the client without parameters:

```typescript
const client = new DeniedClient();
```

For custom or self-hosted instances, you can override the URL:

```typescript
const client = new DeniedClient({
  url: "https://example.denied.dev",
  uuid: "your-uuid-here",
  apiKey: "your-api-key-here",
});
```

### Check Permissions

Check if a principal has permission to perform an action on a resource:

```typescript
async function checkPermission() {
  const response = await client.check({
    principalAttributes: { role: "admin" },
    resourceAttributes: { type: "confidential" },
    action: "read",
  });

  console.log(`Is allowed: ${response.allowed}`);
  if (response.reason) {
    console.log(`Reason: ${response.reason}`);
  }
}
```

You can also use URIs to identify principals and resources:

```typescript
const response = await client.check({
  principalUri: "user:john.doe",
  resourceUri: "document:project-plan",
  action: "write",
});
```

### Bulk Check

Perform multiple permission checks in a single request:

```typescript
import { CheckRequest, EntityType } from "denied-sdk";

async function bulkCheckPermissions() {
  const requests: CheckRequest[] = [
    {
      principal: {
        uri: "user:alice",
        attributes: { role: "editor" },
        type: EntityType.Principal,
      },
      resource: {
        uri: "document:report",
        attributes: { classification: "public" },
        type: EntityType.Resource,
      },
      action: "read",
    },
    {
      principal: {
        uri: "user:bob",
        attributes: { role: "viewer" },
        type: EntityType.Principal,
      },
      resource: {
        uri: "document:report",
        attributes: { classification: "confidential" },
        type: EntityType.Resource,
      },
      action: "write",
    },
  ];

  const responses = await client.bulkCheck(requests);
  responses.forEach((response, index) => {
    console.log(`Check ${index + 1}: Allowed = ${response.allowed}`);
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
- `uuid` (string, optional): The UUID of the specific decision node to use. Defaults to `process.env.DENIED_UUID`
- `apiKey` (string, optional): The API key for authentication. Defaults to `process.env.DENIED_API_KEY`

#### Methods

##### check()

```typescript
check(options: CheckOptions): Promise<CheckResponse>
```

Check if a principal has permission to perform an action on a resource.

**Parameters:**
- `principalUri` (string, optional): URI of the principal
- `resourceUri` (string, optional): URI of the resource
- `principalAttributes` (Record<string, string>, optional): Attributes of the principal
- `resourceAttributes` (Record<string, string>, optional): Attributes of the resource
- `action` (string, optional): The action to check (defaults to "access")

**Returns:** Promise<CheckResponse>
- `allowed` (boolean): Whether the action is allowed
- `reason` (string, optional): Reason for the decision

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
  principal: PrincipalCheck;
  resource: ResourceCheck;
  action: string;
}
```

### CheckResponse

```typescript
interface CheckResponse {
  allowed: boolean;
  reason?: string;
}
```

### EntityType

```typescript
enum EntityType {
  Resource = "resource",
  Principal = "principal",
}
```

## Examples

For more examples, see the [examples](./examples) directory.

## License

Apache-2.0
