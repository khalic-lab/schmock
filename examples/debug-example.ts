/**
 * Debug Mode Example
 * 
 * This example demonstrates Schmock's debug mode functionality.
 * Run with: bun run examples/debug-example.ts
 */

import { schmock } from "../packages/core/src/index";
import { schemaPlugin } from "../packages/schema/src/index";

// Example logging plugin
function loggingPlugin() {
  return {
    name: "logging-plugin",
    version: "1.0.0",
    
    process(context: any, response: any) {
      console.log(`🔍 Logging: Processing ${context.method} ${context.path}`);
      if (response) {
        console.log(`🔍 Logging: Response data for ${context.path}:`, typeof response);
      }
      return { context, response };
    }
  };
}

// Example authentication plugin  
function authPlugin() {
  return {
    name: "auth-plugin",
    version: "1.0.0",
    
    process(context: any, response: any) {
      // Simulate adding user to context
      context.state.set('user', { id: 1, name: 'Test User' });
      
      // If we have a response, add auth header
      if (response && typeof response === 'object') {
        const processedResponse = Array.isArray(response) ? response : [200, response, {}];
        const [status, body, headers = {}] = processedResponse;
        
        return {
          context,
          response: [status, body, {
            ...headers,
            'X-User-ID': context.state.get('user')?.id || 'anonymous'
          }]
        };
      }
      
      return { context, response };
    }
  };
}

async function runDebugExample() {
  console.log("=== Schmock Debug Mode Example ===\n");
  
  // Create mock instance with debug mode enabled
  const mock = schmock({ debug: true });
  
  // Add plugins
  mock.pipe(loggingPlugin());
  mock.pipe(authPlugin());
  mock.pipe(schemaPlugin());
  
  // Define routes
  mock("GET /api/users", {
    schema: {
      type: "array",
      items: {
        type: "object", 
        properties: {
          id: { type: "number" },
          name: { type: "string", faker: "person.fullName" },
          email: { type: "string", format: "email" }
        }
      }
    },
    count: 3
  });
  
  mock("GET /api/users/:id", (ctx) => ({
    id: parseInt(ctx.params.id),
    name: `User ${ctx.params.id}`,
    email: `user${ctx.params.id}@example.com`
  }));
  
  mock("POST /api/error", () => {
    throw new Error("Simulated error for testing");
  });

  console.log("\n1. Testing successful request to /api/users:");
  console.log("=" .repeat(50));
  
  try {
    const response1 = await mock.handle("GET", "/api/users", {
      headers: { "User-Agent": "Debug Example" },
      query: { limit: "10" }
    });
    console.log("✅ Response:", {
      status: response1.status,
      userCount: Array.isArray(response1.body) ? response1.body.length : 'not array',
      hasAuthHeader: !!response1.headers['X-User-ID']
    });
  } catch (error) {
    console.error("❌ Error:", error);
  }

  console.log("\n2. Testing parameterized request to /api/users/123:");
  console.log("=" .repeat(50));
  
  try {
    const response2 = await mock.handle("GET", "/api/users/123");
    console.log("✅ Response:", response2.body);
  } catch (error) {
    console.error("❌ Error:", error);
  }

  console.log("\n3. Testing error handling with POST /api/error:");
  console.log("=" .repeat(50));
  
  try {
    const response3 = await mock.handle("POST", "/api/error");
    console.log("✅ Response:", response3);
  } catch (error) {
    console.error("❌ Error:", error);
  }

  console.log("\n4. Testing 404 for non-existent route:");
  console.log("=" .repeat(50));
  
  try {
    const response4 = await mock.handle("GET", "/api/nonexistent");
    console.log("✅ Response:", response4);
  } catch (error) {
    console.error("❌ Error:", error);
  }

  console.log("\n=== Debug Mode Example Complete ===");
}

// Run the example
runDebugExample().catch(console.error);