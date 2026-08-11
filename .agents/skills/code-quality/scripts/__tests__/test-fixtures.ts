import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PACKAGES = [
  "angular",
  "cli",
  "core",
  "express",
  "faker",
  "openapi",
  "query",
  "react",
  "validation",
  "vue",
];

export function createWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "schmock-quality-test-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
  );

  for (const name of [...TEST_PACKAGES, "schmock"]) {
    const directory = join(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    const scripts =
      name === "schmock"
        ? { build: "true" }
        : {
            ...(name === "core"
              ? { pretest: "touch ../../pretest.marker" }
              : {}),
            test: "vitest",
            "test:bdd": "vitest",
          };
    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify({ name: `@schmock/${name}`, scripts }, null, 2)}\n`,
    );
  }

  const binaryDirectory = join(root, "node_modules", ".bin");
  mkdirSync(binaryDirectory, { recursive: true });
  const vitest = join(binaryDirectory, "vitest");
  writeFileSync(vitest, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(vitest, 0o755);

  return root;
}

export function createFakeBun(root: string, failingCommand?: string): string {
  const directory = join(root, "fake-bin");
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "bun");
  const failure = failingCommand
    ? `if [ "$*" = ${JSON.stringify(failingCommand)} ]; then exit 23; fi\n`
    : "";
  writeFileSync(executable, `#!/usr/bin/env bash\n${failure}exit 0\n`);
  chmodSync(executable, 0o755);
  return directory;
}

export function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export const testPackages = TEST_PACKAGES;
