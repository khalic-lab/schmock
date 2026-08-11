import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

function coreDeclarationPath() {
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    const manifestPath = require.resolve("@schmock/core/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.types !== "string") {
      throw new Error("Packed @schmock/core has no types entry");
    }
    return resolve(dirname(manifestPath), manifest.types);
  } catch (error) {
    const workspaceDeclaration = resolve(
      import.meta.dirname,
      "../packages/core/dist/index.d.ts",
    );
    try {
      readFileSync(workspaceDeclaration);
      return workspaceDeclaration;
    } catch {
      throw error;
    }
  }
}

const coreDeclaration = coreDeclarationPath();

const fixtureDirectory = mkdtempSync(
  join(process.cwd(), ".schmock-typescript-5-6-"),
);

try {
  writeFileSync(
    join(fixtureDirectory, "entry.ts"),
    [
      'import { schmock, serializeResponseBody } from "@schmock/core";',
      'const response = await schmock().handle("GET", "/missing");',
      "const bytes: Uint8Array | undefined = serializeResponseBody(response);",
      "void bytes;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
          baseUrl: ".",
          paths: {
            "@schmock/core": [coreDeclaration],
          },
        },
        files: ["entry.ts"],
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    "[typescript-5.6 1/1] Compiling the packed Core declaration entry\n",
  );
  const result = spawnSync(
    "bunx",
    ["-p", "typescript@5.6.3", "tsc", "--project", "tsconfig.json"],
    {
      cwd: fixtureDirectory,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("TypeScript 5.6 could not consume @schmock/core");
  }
} finally {
  rmSync(fixtureDirectory, { force: true, recursive: true });
}
