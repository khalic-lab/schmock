import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { 
  createTempProject, 
  buildLocalPackages, 
  installLocalPackages,
  startServer,
  getAvailablePort,
  httpRequest,
  waitForServer,
  type TestProject,
  type PackageInfo
} from "../utils/index.js";

describe("Express Integration E2E", () => {
  let packages: PackageInfo[];
  let cleanupTasks: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build local packages once for all tests
    packages = await buildLocalPackages();
  }, 60000); // 60s timeout for building

  afterEach(async () => {
    // Cleanup all resources from this test
    await Promise.all(cleanupTasks.map(cleanup => cleanup()));
    cleanupTasks = [];
  });

  it("should serve basic mock API through Express", async () => {
    // Setup test project
    const project = await createTempProject("basic-express");
    cleanupTasks.push(project.cleanup);

    // Install local packages
    await installLocalPackages(project.dir, packages);

    // Get available port
    const port = await getAvailablePort();

    // Start server
    const server = await startServer(project.dir, port, 30000);
    cleanupTasks.push(async () => server.kill());

    // Wait for server to be ready
    const baseUrl = `http://localhost:${port}`;
    await waitForServer(`${baseUrl}/mock/api/users`, 10000);

    // Test the mock API
    const response = await httpRequest(`${baseUrl}/mock/api/users`);
    
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    
    const data = response.json();
    expect(data).toEqual({
      users: [{ id: 1, name: "John" }]
    });
  }, 90000); // 90s timeout for full E2E test

  it("should handle 404 for non-matching routes", async () => {
    const project = await createTempProject("basic-express");
    cleanupTasks.push(project.cleanup);

    await installLocalPackages(project.dir, packages);
    const port = await getAvailablePort();
    const server = await startServer(project.dir, port, 30000);
    cleanupTasks.push(async () => server.kill());

    const baseUrl = `http://localhost:${port}`;
    await waitForServer(`${baseUrl}/mock/api/users`, 10000);

    // Test non-matching route
    const response = await httpRequest(`${baseUrl}/mock/api/nonexistent`);
    expect(response.status).toBe(404);
  }, 90000);

  it("should handle different HTTP methods", async () => {
    // Create a more complex test project
    const project = await createTempProject();
    cleanupTasks.push(project.cleanup);

    // Create custom test file with different methods
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    
    await writeFile(join(project.dir, "index.js"), `import express from 'express';
import { schmock } from '@schmock/builder';
import { toExpress } from '@schmock/express';

const app = express();
app.use(express.json());

const mock = schmock()
  .routes({
    'GET /api/users': {
      response: () => ({ users: [] })
    },
    'POST /api/users': {
      response: () => ({ id: 1, created: true })
    },
    'PUT /api/users/:id': {
      response: (ctx) => ({ id: ctx.params.id, updated: true })
    }
  })
  .build();

app.use('/mock', toExpress(mock));

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(\`Server running on port \${port}\`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
`);

    await installLocalPackages(project.dir, packages);
    const port = await getAvailablePort();
    const server = await startServer(project.dir, port, 30000);
    cleanupTasks.push(async () => server.kill());

    const baseUrl = `http://localhost:${port}`;
    await waitForServer(`${baseUrl}/mock/api/users`, 10000);

    // Test GET
    const getResponse = await httpRequest(`${baseUrl}/mock/api/users`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.json()).toEqual({ users: [] });

    // Test POST
    const postResponse = await httpRequest(`${baseUrl}/mock/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Jane" })
    });
    expect(postResponse.status).toBe(200);
    expect(postResponse.json()).toEqual({ id: 1, created: true });

    // Test PUT with params
    const putResponse = await httpRequest(`${baseUrl}/mock/api/users/123`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Jane" })
    });
    expect(putResponse.status).toBe(200);
    expect(putResponse.json()).toEqual({ id: "123", updated: true });
  }, 90000);
});