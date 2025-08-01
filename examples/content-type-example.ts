/**
 * Content Type Auto-Detection and Validation Example
 * 
 * This example demonstrates Schmock's automatic content type detection,
 * explicit content type setting, and content validation features.
 * Run with: bun run examples/content-type-example.ts
 */

import { schmock } from "../packages/core/src/index";

async function runContentTypeExample() {
  console.log("=== Schmock Content Type Auto-Detection and Validation Example ===\n");
  
  const mock = schmock();
  
  // ===== AUTO-DETECTION EXAMPLES =====
  
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
  
  // ===== EXPLICIT CONTENT TYPE EXAMPLES =====
  
  // XML with explicit content type
  mock("GET /api/xml", () => [
    200,
    '<?xml version="1.0"?><root><message>Hello XML</message></root>',
    { "Content-Type": "application/xml" }
  ]);
  
  // Custom JSON API content type
  mock("GET /api/custom-json", () => [
    200,
    { data: "custom", type: "resource" },
    { "Content-Type": "application/vnd.api+json" }
  ]);
  
  // HTML content
  mock("GET /api/html", () => [
    200,
    "<html><body><h1>Hello HTML</h1></body></html>",
    { "Content-Type": "text/html" }
  ]);
  
  // Plain text with charset
  mock("GET /api/text-utf8", () => [
    200,
    "Hello, UTF-8 World! 🌍",
    { "Content-Type": "text/plain; charset=utf-8" }
  ]);
  
  // Binary data (base64 encoded for example)
  mock("GET /api/binary", () => [
    200,
    Buffer.from("Hello Binary World!", "utf-8"),
    { "Content-Type": "application/octet-stream" }
  ]);
  
  // CSV data
  mock("GET /api/csv", () => [
    200,
    "id,name,email\n1,John,john@example.com\n2,Jane,jane@example.com",
    { "Content-Type": "text/csv" }
  ]);
  
  // ===== CONTENT VALIDATION EXAMPLES =====
  
  // Route that validates request content type
  mock("POST /api/json-only", (ctx) => {
    const contentType = ctx.headers["content-type"];
    if (!contentType || !contentType.includes("application/json")) {
      return [
        400,
        { error: "Content-Type must be application/json" },
        { "Content-Type": "application/json" }
      ];
    }
    return { message: "JSON received successfully", data: ctx.body };
  });
  
  // Route that handles multiple content types
  mock("POST /api/flexible", (ctx) => {
    const contentType = ctx.headers["content-type"] || "";
    
    if (contentType.includes("application/json")) {
      return { message: "Processed JSON data", type: "json", data: ctx.body };
    } else if (contentType.includes("text/plain")) {
      return { message: "Processed text data", type: "text", data: ctx.body };
    } else if (contentType.includes("application/xml")) {
      return { message: "Processed XML data", type: "xml", data: ctx.body };
    } else {
      return [
        415,
        { error: "Unsupported Media Type", supported: ["application/json", "text/plain", "application/xml"] }
      ];
    }
  });

  // ===== TESTING AUTO-DETECTION =====
  
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
  
  // ===== TESTING EXPLICIT CONTENT TYPES =====
  
  console.log("\n4. Testing explicit XML content type:");
  console.log("=" .repeat(50));
  const response4 = await mock.handle("GET", "/api/xml");
  console.log("Status:", response4.status);
  console.log("Body:", response4.body);
  console.log("Content-Type:", response4.headers["Content-Type"] || "not set");
  
  console.log("\n5. Testing custom JSON API content type:");
  console.log("=" .repeat(50));
  const response5 = await mock.handle("GET", "/api/custom-json");
  console.log("Status:", response5.status);
  console.log("Body:", response5.body);
  console.log("Content-Type:", response5.headers["Content-Type"] || "not set");
  
  console.log("\n6. Testing HTML content:");
  console.log("=" .repeat(50));
  const response6 = await mock.handle("GET", "/api/html");
  console.log("Status:", response6.status);
  console.log("Body:", response6.body);
  console.log("Content-Type:", response6.headers["Content-Type"] || "not set");
  
  console.log("\n7. Testing UTF-8 text with charset:");
  console.log("=" .repeat(50));
  const response7 = await mock.handle("GET", "/api/text-utf8");
  console.log("Status:", response7.status);
  console.log("Body:", response7.body);
  console.log("Content-Type:", response7.headers["Content-Type"] || "not set");
  
  console.log("\n8. Testing CSV data:");
  console.log("=" .repeat(50));
  const response8 = await mock.handle("GET", "/api/csv");
  console.log("Status:", response8.status);
  console.log("Body:", response8.body);
  console.log("Content-Type:", response8.headers["Content-Type"] || "not set");
  
  // ===== TESTING CONTENT VALIDATION =====
  
  console.log("\n9. Testing JSON-only validation with correct content type:");
  console.log("=" .repeat(50));
  const response9 = await mock.handle("POST", "/api/json-only", {
    headers: { "Content-Type": "application/json" },
    body: { test: "data" }
  });
  console.log("Status:", response9.status);
  console.log("Body:", response9.body);
  
  console.log("\n10. Testing JSON-only validation with wrong content type:");
  console.log("=" .repeat(50));
  const response10 = await mock.handle("POST", "/api/json-only", {
    headers: { "Content-Type": "text/plain" },
    body: "plain text"
  });
  console.log("Status:", response10.status);
  console.log("Body:", response10.body);
  
  console.log("\n11. Testing flexible content type handling with JSON:");
  console.log("=" .repeat(50));
  const response11 = await mock.handle("POST", "/api/flexible", {
    headers: { "Content-Type": "application/json" },
    body: { message: "JSON data" }
  });
  console.log("Status:", response11.status);
  console.log("Body:", response11.body);
  
  console.log("\n12. Testing flexible content type handling with XML:");
  console.log("=" .repeat(50));
  const response12 = await mock.handle("POST", "/api/flexible", {
    headers: { "Content-Type": "application/xml" },
    body: "<message>XML data</message>"
  });
  console.log("Status:", response12.status);
  console.log("Body:", response12.body);
  
  console.log("\n13. Testing unsupported media type:");
  console.log("=" .repeat(50));
  const response13 = await mock.handle("POST", "/api/flexible", {
    headers: { "Content-Type": "image/png" },
    body: "binary data"
  });
  console.log("Status:", response13.status);
  console.log("Body:", response13.body);

  console.log("\n=== Content Type Auto-Detection and Validation Example Complete ===");
}

// Run the example
runContentTypeExample().catch(console.error);