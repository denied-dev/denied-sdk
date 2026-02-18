/* eslint-disable no-console */
import { CheckRequest, DeniedClient } from "denied-sdk";

async function run(): Promise<void> {
  const client = new DeniedClient({
    apiKey: "your-api-key-here",
  });

  try {
    // Example 1: Simple check with properties
    console.log("Example 1: Checking permissions with properties...");
    const response1 = await client.check({
      subjectType: "user",
      subjectId: "admin",
      subjectProperties: { role: "admin" },
      resourceType: "document",
      resourceId: "confidential-doc",
      resourceProperties: { classification: "confidential" },
      action: "read",
    });
    console.log(`Decision: ${response1.decision}`);
    if (response1.context?.reason) {
      console.log(`Reason: ${response1.context.reason}`);
    }

    // Example 2: Check with type and id
    console.log("\nExample 2: Checking permissions with type and id...");
    const response2 = await client.check({
      subjectType: "user",
      subjectId: "john.doe",
      resourceType: "document",
      resourceId: "project-plan",
      action: "write",
    });
    console.log(`Decision: ${response2.decision}`);

    // Example 3: Bulk check
    console.log("\nExample 3: Performing bulk check...");
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

    const bulkResponses = await client.bulkCheck(requests);
    bulkResponses.forEach((response, index) => {
      console.log(`Check ${index + 1}: ${response.decision}`);
    });

    // Example 4: Check with context
    console.log("\nExample 4: Checking with additional context...");
    const response4 = await client.check({
      subjectType: "user",
      subjectId: "alice",
      resourceType: "api",
      resourceId: "payment-service",
      action: "execute",
      context: { ip: "192.168.1.1", timestamp: Date.now() },
    });
    console.log(`Decision: ${response4.decision}`);
  } catch (error) {
    console.error("Error:", error);
  }
}

run().catch(console.error);
