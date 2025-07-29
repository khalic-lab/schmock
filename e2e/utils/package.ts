import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";

export interface PackageInfo {
  name: string;
  tarballPath: string;
}

/**
 * Build and pack local packages for testing
 */
export async function buildLocalPackages(): Promise<PackageInfo[]> {
  const rootDir = join(__dirname, "../..");
  
  console.log("Building packages for E2E testing...");
  
  // Build all packages
  execSync("bun run build", { cwd: rootDir, stdio: "inherit" });
  
  const packages: PackageInfo[] = [];
  
  // Pack builder package
  const builderDir = join(rootDir, "packages/builder");
  execSync("npm pack --silent", { cwd: builderDir, stdio: "pipe" });
  
  // Find the generated tarball
  const builderTarball = "schmock-builder-0.1.0.tgz"; // Based on package.json name/version
  
  packages.push({
    name: "@schmock/builder",
    tarballPath: join(builderDir, builderTarball)
  });
  
  // Pack express package
  try {
    const expressDir = join(rootDir, "packages/express");
    execSync("npm pack --silent", { cwd: expressDir, stdio: "pipe" });
    
    const expressTarball = "schmock-express-0.1.0.tgz";
    
    packages.push({
      name: "@schmock/express", 
      tarballPath: join(expressDir, expressTarball)
    });
  } catch (error) {
    console.warn("@schmock/express package not found, skipping...");
  }
  
  return packages;
}

/**
 * Install local packages in test project
 */
export async function installLocalPackages(
  projectDir: string, 
  packages: PackageInfo[]
): Promise<void> {
  const packageJsonPath = join(projectDir, "package.json");
  
  // Read existing package.json
  const packageJsonContent = await readFile(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(packageJsonContent);
  
  // Add local package dependencies
  packageJson.dependencies = packageJson.dependencies || {};
  
  for (const pkg of packages) {
    packageJson.dependencies[pkg.name] = `file:${pkg.tarballPath}`;
  }
  
  // Write updated package.json
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
  
  // Install dependencies (silently)
  execSync("npm install --silent", { cwd: projectDir, stdio: "pipe" });
}

/**
 * Start server process and wait for it to be ready
 */
export async function startServer(
  projectDir: string, 
  port: number,
  timeout: number = 30000
): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: port.toString() };
    const serverProcess = spawn("npm", ["start"], { 
      cwd: projectDir, 
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    
    let output = "";
    let isResolved = false;
    
    const cleanup = () => {
      if (!serverProcess.killed) {
        serverProcess.kill("SIGTERM");
        // Force kill after 5s if still running
        setTimeout(() => {
          if (!serverProcess.killed) {
            serverProcess.kill("SIGKILL");
          }
        }, 5000);
      }
    };
    
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        reject(new Error(`Server startup timeout after ${timeout}ms. Output: ${output}`));
      }
    }, timeout);
    
    serverProcess.stdout?.on("data", (data) => {
      output += data.toString();
      // Look for server ready signal
      if (output.includes(`Server running on port ${port}`) && !isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        resolve({ kill: cleanup });
      }
    });
    
    serverProcess.stderr?.on("data", (data) => {
      output += data.toString();
    });
    
    serverProcess.on("error", (error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(error);
      }
    });
    
    serverProcess.on("exit", (code) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new Error(`Server exited with code ${code}. Output: ${output}`));
      }
    });
  });
}