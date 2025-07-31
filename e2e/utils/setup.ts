import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TestProject {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTempProject(template: string = "basic-express"): Promise<TestProject> {
  // Create temporary directory
  const tempDir = await mkdtemp(join(tmpdir(), "schmock-e2e-"));
  
  // Get template directory
  const templateDir = join(__dirname, "../fixtures", template);
  
  // Copy template files to temp directory
  await copyTemplate(templateDir, tempDir);
  
  return {
    dir: tempDir,
    cleanup: async () => {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Failed to cleanup temp dir ${tempDir}:`, error);
      }
    }
  };
}

async function copyTemplate(templateDir: string, targetDir: string): Promise<void> {
  const { readdir, stat, copyFile } = await import("node:fs/promises");
  
  try {
    const items = await readdir(templateDir);
    
    for (const item of items) {
      const sourcePath = join(templateDir, item);
      const targetPath = join(targetDir, item);
      
      const stats = await stat(sourcePath);
      
      if (stats.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await copyTemplate(sourcePath, targetPath);
      } else if (stats.isFile()) {
        await copyFile(sourcePath, targetPath);
      }
    }
  } catch (error) {
    // Template doesn't exist, create minimal project
    if (templateDir.includes("basic-express")) {
      await createBasicExpressTemplate(targetDir);
    } else {
      throw error;
    }
  }
}

async function createBasicExpressTemplate(targetDir: string): Promise<void> {
  // package.json
  await writeFile(join(targetDir, "package.json"), JSON.stringify({
    name: "schmock-e2e-test",
    version: "0.0.1",
    type: "module",
    scripts: {
      start: "node index.js"
    },
    dependencies: {
      express: "^4.18.2",
      "@types/express": "^4.17.17"
    }
  }, null, 2));

  // index.js template
  await writeFile(join(targetDir, "index.js"), `import express from 'express';
import { schmock } from '@schmock/core';
import { toExpress } from '@schmock/express';

const app = express();

// Create mock
const mock = schmock()
  .routes({
    'GET /api/users': {
      response: () => ({ users: [{ id: 1, name: 'John' }] })
    }
  })
  .build();

// Mount to Express
app.use('/mock', toExpress(mock));

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(\`Server running on port \${port}\`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
`);
}

export async function getAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  
  return new Promise((resolve, reject) => {
    const server = createServer();
    
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    
    server.on('error', reject);
  });
}