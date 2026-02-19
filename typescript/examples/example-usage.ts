/* eslint-disable no-console */
import { CheckRequest, DeniedClient } from "denied-sdk";

async function run(): Promise<void> {
  const client = new DeniedClient({
    apiKey: "your-api-key-here",
  });

  try {
    // 1.1. Single check / Simple URI string shorthand
    console.log("Example 1: URI string shorthand...");
    const response1 = await client.check({
      subject: "user://alice",
      action: "read",
      resource: "document://secret",
    });
    console.log(`Decision: ${response1.decision}`);

    // 1.2. Single check / Typed objects
    console.log("\nExample 2: Typed objects with properties...");
    const response2 = await client.check({
      subject: { type: "user", id: "admin", properties: { role: "admin" } },
      action: { name: "read" },
      resource: {
        type: "document",
        id: "confidential-doc",
        properties: { classification: "confidential" },
      },
    });
    console.log(`Decision: ${response2.decision}`);

    // 1.3. Single check / Mixed strings and objects with optional context
    console.log("\nExample 3: Mixed with context...");
    const response3 = await client.check({
      subject: "user://alice",
      action: "execute",
      resource: "api://payment-service",
      context: { ip: "192.168.1.1", timestamp: Date.now() },
    });
    console.log(`Decision: ${response3.decision}`);

    // 2. Multiple bulk checks
    console.log("\nExample 4: Performing bulk check...");
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

    const bulkResponses = await client.bulkCheck(requests);
    bulkResponses.forEach((response, index) => {
      console.log(`Check ${index + 1}: ${response.decision}`);
    });
  } catch (error) {
    console.error("Error:", error);
  }
}

run().catch(console.error);
