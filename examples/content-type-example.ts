/**
 * Content Type Auto-Detection Example
 * 
 * This example demonstrates Schmock's automatic content type detection feature.
 * Run with: bun run examples/content-type-example.ts
 */

import { schmock } from "../packages/core/src/index";

async function runContentTypeExample() {
  console.log("=== Schmock Content Type Auto-Detection Example ===\n");
  
  const mock = schmock();
  
  // String responses auto-detect to text/plain
  mock("GET /api/text", () => "Hello, World!");
  
  // Object responses auto-detect to application/json
  mock("GET /api/json", () => ({ message: "Hello, JSON!" }));
  
  // Array responses auto-detect to application/json
  mock("GET /api/array", () => [1, 2, 3, { id: 4, name: "Item" }]);
  
  // Number responses auto-detect to text/plain
  mock("GET /api/number", () => 42);
  
  // Boolean responses auto-detect to text/plain
  mock("GET /api/boolean", () => true);
  
  // Explicit content type override using tuple format
  mock("GET /api/xml", () => [
    200,
    '<?xml version="1.0"?><root><message>Hello XML</message></root>',
    { "Content-Type": "application/xml" }
  ]);
  
  // Custom content type with JSON data
  mock("GET /api/custom-json", () => [
    200,
    { data: "custom" },
    { "Content-Type": "application/vnd.api+json" }
  ]);

  console.log("1. Testing string response (auto-detects text/plain):");
  console.log("=" .repeat(50));
  const response1 = await mock.handle("GET", "/api/text");
  console.log("Status:", response1.status);
  console.log("Body:", response1.body);
  console.log("Content-Type:", response1.headers["Content-Type"] || "not set");
  
  console.log("\n2. Testing object response (auto-detects application/json):");
  console.log("=" .repeat(50));
  const response2 = await mock.handle("GET", "/api/json");
  console.log("Status:", response2.status);
  console.log("Body:", response2.body);
  console.log("Content-Type:", response2.headers["Content-Type"] || "not set");
  
  console.log("\n3. Testing array response (auto-detects application/json):");
  console.log("=" .repeat(50));
  const response3 = await mock.handle("GET", "/api/array");
  console.log("Status:", response3.status);
  console.log("Body:", response3.body);
  console.log("Content-Type:", response3.headers["Content-Type"] || "not set");
  
  console.log("\n4. Testing number response (auto-detects text/plain):");
  console.log("=" .repeat(50));
  const response4 = await mock.handle("GET", "/api/number");
  console.log("Status:", response4.status);
  console.log("Body:", response4.body);
  console.log("Content-Type:", response4.headers["Content-Type"] || "not set");
  
  console.log("\n5. Testing boolean response (auto-detects text/plain):");
  console.log("=" .repeat(50));
  const response5 = await mock.handle("GET", "/api/boolean");
  console.log("Status:", response5.status);
  console.log("Body:", response5.body);
  console.log("Content-Type:", response5.headers["Content-Type"] || "not set");
  
  console.log("\n6. Testing explicit XML content type:");
  console.log("=" .repeat(50));
  const response6 = await mock.handle("GET", "/api/xml");
  console.log("Status:", response6.status);
  console.log("Body:", response6.body);
  console.log("Content-Type:", response6.headers["Content-Type"] || "not set");
  
  console.log("\n7. Testing custom JSON content type:");
  console.log("=" .repeat(50));
  const response7 = await mock.handle("GET", "/api/custom-json");
  console.log("Status:", response7.status);
  console.log("Body:", response7.body);
  console.log("Content-Type:", response7.headers["Content-Type"] || "not set");

  console.log("\n=== Content Type Auto-Detection Example Complete ===");
}

// Run the example
runContentTypeExample().catch(console.error);