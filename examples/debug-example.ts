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
    enforce: "pre" as const,
    
    beforeRequest(context: any) {
      console.log(`🔍 Logging: Processing ${context.method} ${context.path}`);
      return context;
    },
    
    afterGenerate(data: any, context: any) {
      console.log(`🔍 Logging: Generated data for ${context.path}:`, typeof data);
      return data;
    }
  };
}

// Example authentication plugin  
function authPlugin() {
  return {
    name: "auth-plugin",
    version: "1.0.0",
    
    beforeRequest(context: any) {
      // Simulate adding user to context
      context.state.set('user', { id: 1, name: 'Test User' });
      return context;
    },
    
    beforeResponse(response: any, context: any) {
      // Add auth header to response
      return {
        ...response,
        headers: {
          ...response.headers,
          'X-User-ID': context.state.get('user')?.id || 'anonymous'
        }
      };
    }
  };
}

async function runDebugExample() {
  console.log("=== Schmock Debug Mode Example ===\n");
  
  // Create mock instance with debug mode enabled
  const mock = schmock()
    .config({ 
      debug: true  // Enable debug mode
    })
    .use(loggingPlugin())
    .use(authPlugin())
    .use(schemaPlugin())
    .routes({
      "GET /api/users": {
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
      },
      "GET /api/users/:id": (ctx) => ({
        id: parseInt(ctx.params.id),
        name: `User ${ctx.params.id}`,
        email: `user${ctx.params.id}@example.com`
      }),
      "POST /api/error": () => {
        throw new Error("Simulated error for testing");
      }
    })
    .build();

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