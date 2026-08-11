#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

interface Workspace {
  directory: string;
  name: string;
  scripts: Record<string, string>;
  shortName: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read ${path}: ${detail}`);
  }
}

function containedBy(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export function findRepoRoot(): string {
  const override = process.env.SCHMOCK_REPO_ROOT;
  let candidate: string;

  if (override) {
    candidate = isAbsolute(override)
      ? override
      : resolve(process.cwd(), override);
  } else {
    const result = spawnSync(
      "git",
      ["-C", import.meta.dir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      fail(
        "Cannot locate the Schmock repository. Set SCHMOCK_REPO_ROOT explicitly.",
      );
    }
    candidate = result.stdout.trim();
  }

  if (!existsSync(join(candidate, "package.json"))) {
    fail(`Repository package.json not found under ${candidate}`);
  }

  return realpathSync(candidate);
}

function workspacePatterns(rootManifest: Record<string, unknown>): string[] {
  const configured = rootManifest.workspaces;
  const patterns = Array.isArray(configured)
    ? configured
    : isRecord(configured) && Array.isArray(configured.packages)
      ? configured.packages
      : [];

  if (!patterns.every((pattern) => typeof pattern === "string")) {
    fail("Root workspaces must be an array of string patterns");
  }

  return patterns;
}

export function discoverWorkspaces(root = findRepoRoot()): Workspace[] {
  const manifestValue = readJson(join(root, "package.json"));
  if (!isRecord(manifestValue)) {
    fail("Root package.json must contain a JSON object");
  }

  const workspaces = new Map<string, Workspace>();
  for (const rawPattern of workspacePatterns(manifestValue)) {
    const pattern = rawPattern.replace(/^\.\//, "");
    const match = /^([a-zA-Z0-9._/-]+)\/\*$/.exec(pattern);
    if (!match) {
      fail(`Unsupported workspace pattern: ${rawPattern}`);
    }

    const parent = resolve(root, match[1]);
    if (!containedBy(root, parent) || !existsSync(parent)) {
      fail(
        `Workspace directory is outside the repository or missing: ${match[1]}`,
      );
    }

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const directory = realpathSync(join(parent, entry.name));
      if (!containedBy(parent, directory)) {
        fail(`Workspace resolves outside ${parent}: ${entry.name}`);
      }

      const packageJson = join(directory, "package.json");
      if (!existsSync(packageJson)) continue;

      const value = readJson(packageJson);
      if (!isRecord(value) || typeof value.name !== "string") {
        fail(`Workspace manifest has no valid name: ${packageJson}`);
      }

      const expectedName = `@schmock/${basename(directory)}`;
      if (value.name !== expectedName) {
        fail(
          `Workspace name ${value.name} does not match directory ${expectedName}`,
        );
      }

      const scriptValue = value.scripts;
      const scripts: Record<string, string> = {};
      if (isRecord(scriptValue)) {
        for (const [name, command] of Object.entries(scriptValue)) {
          if (typeof command === "string") scripts[name] = command;
        }
      }

      const workspace = {
        directory,
        name: value.name,
        scripts,
        shortName: basename(directory),
      };
      if (workspaces.has(workspace.name)) {
        fail(`Duplicate workspace name: ${workspace.name}`);
      }
      workspaces.set(workspace.name, workspace);
    }
  }

  if (workspaces.size === 0) fail("No Schmock workspaces were discovered");
  return [...workspaces.values()].sort((left, right) =>
    left.shortName.localeCompare(right.shortName),
  );
}

function parseScriptOption(args: string[]): string | undefined {
  const index = args.indexOf("--script");
  if (index === -1) return undefined;
  const script = args[index + 1];
  if (!script || index + 2 !== args.length)
    fail("Usage error: --script requires one value");
  return script;
}

function eligible(workspaces: Workspace[], script?: string): Workspace[] {
  return script
    ? workspaces.filter(
        (workspace) => typeof workspace.scripts[script] === "string",
      )
    : workspaces;
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const root = findRepoRoot();
  if (command === "root") {
    console.log(root);
    return;
  }

  const workspaces = discoverWorkspaces(root);
  if (command === "list") {
    const script = parseScriptOption(args);
    for (const workspace of eligible(workspaces, script)) {
      console.log(workspace.shortName);
    }
    return;
  }

  if (command === "resolve") {
    const target = args[0];
    if (!target)
      fail("Usage: workspaces.ts resolve <package> [--script <name>]");
    const script = parseScriptOption(args.slice(1));
    const workspace = workspaces.find(
      (candidate) =>
        candidate.shortName === target || candidate.name === target,
    );
    if (!workspace) {
      fail(
        `Unknown package: ${target}. Valid packages: ${workspaces.map((item) => item.shortName).join(", ")}`,
      );
    }
    if (script && typeof workspace.scripts[script] !== "string") {
      const valid = eligible(workspaces, script)
        .map((item) => item.shortName)
        .join(", ");
      fail(
        `Package ${workspace.shortName} has no ${script} script. Valid packages: ${valid}`,
      );
    }
    console.log(
      `${workspace.shortName}\t${workspace.directory}\t${workspace.name}`,
    );
    return;
  }

  fail(
    "Usage: workspaces.ts root | list [--script <name>] | resolve <package> [--script <name>]",
  );
}

if (import.meta.main) main();
