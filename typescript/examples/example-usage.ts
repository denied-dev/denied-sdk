/* eslint-disable no-console */
import { CheckRequest, EntityType, DeniedClient } from "denied-sdk";

async function run(): Promise<void> {
  const client = new DeniedClient({
    url: "http://localhost:8421",
    apiKey: "your-api-key-here",
  });

  try {
    // Example 1: Simple check with attributes
    console.log("Example 1: Checking permissions with attributes...");
    const response1 = await client.check({
      principalAttributes: { role: "admin" },
      resourceAttributes: { type: "confidential" },
      action: "read",
    });
    console.log(`Is allowed: ${response1.allowed}`);
    if (response1.reason) {
      console.log(`Reason: ${response1.reason}`);
    }

    // Example 2: Check with URIs
    console.log("\nExample 2: Checking permissions with URIs...");
    const response2 = await client.check({
      principalUri: "user:john.doe",
      resourceUri: "document:project-plan",
      action: "write",
    });
    console.log(`Is allowed: ${response2.allowed}`);

    // Example 3: Bulk check
    console.log("\nExample 3: Performing bulk check...");
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

    const bulkResponses = await client.bulkCheck(requests);
    bulkResponses.forEach((response, index) => {
      console.log(`Check ${index + 1}: ${response.allowed}`);
    });
  } catch (error) {
    console.error("Error:", error);
  }
}

run().catch(console.error);
