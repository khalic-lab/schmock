/**
 * Executable documentation.
 *
 * Runs the code fences in `docs/getting-started.md` so that a documented
 * snippet which no longer works against the current API fails a test instead of
 * quietly rotting.
 *
 * How a fence opts in
 * -------------------
 * Only fences whose info string carries `docs-run=<group>` are executed:
 *
 *     ```typescript docs-run=basics
 *
 * Markdown renderers ignore the extra info-string word, so the rendered page is
 * unchanged. Every `ts`/`typescript` fence WITHOUT a tag is reported as an
 * explicitly skipped test naming its line range — a snippet is never silently
 * ignored, it is either executed or visibly skipped.
 *
 * How a group is built
 * --------------------
 * All fences sharing a group id are concatenated in document order into one
 * module, which is written to a temporary `.ts` file inside this directory,
 * strict-typechecked with the repository tsconfig, and imported (vitest and
 * TypeScript resolve `@schmock/core` & co. to `packages/*\/src`). One rule
 * applies to the concatenated source: if it contains no top-level `import`, a
 * single
 * `import { schmock } from "@schmock/core"` preamble is prepended. Nothing else
 * is injected. That is why a group's FIRST fence must be the one that creates
 * the mock instance the later fences use.
 *
 * What this does and does not prove
 * ---------------------------------
 * - It proves the snippets strict-typecheck and execute: renamed methods,
 *   changed signatures, unsafe access to unknown request data, and runtime
 *   assertion failures all fail here.
 * - Tagged examples that handle requests assert their status/body outcomes so
 *   a resolved 404/500 response cannot masquerade as successful execution.
 *
 * EXPECTED_GROUPS below pins the tags this file expects to find. If a doc edit
 * drops or renames a tag, the pin fails loudly — otherwise losing the tags
 * would leave this suite green with nothing to run.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const DOC_LABEL = "docs/getting-started.md";
const ROOT_DIR = resolve(__dirname, "../..");
const DOC_PATH = resolve(ROOT_DIR, DOC_LABEL);

/** Tag -> number of fences expected to carry it. */
const EXPECTED_GROUPS: Record<string, number> = {
  basics: 7,
  stateful: 3,
  state: 2,
};

const PREAMBLE = 'import { schmock } from "@schmock/core"\n';

const EXECUTABLE_LANGS = new Set(["ts", "typescript"]);
const TAG_PATTERN = /(?:^|\s)docs-run=([A-Za-z0-9_-]+)(?:\s|$)/;

interface Fence {
  lang: string;
  info: string;
  group: string | undefined;
  startLine: number;
  endLine: number;
  code: string;
}

function parseFences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const fences: Fence[] = [];
  let open: { lang: string; info: string; startLine: number } | undefined;
  let buffer: string[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (open === undefined) {
      const match = /^```(\S+)[ \t]*(.*)$/.exec(line);
      if (match) {
        open = {
          lang: match[1],
          info: match[2].trim(),
          startLine: lineNumber,
        };
        buffer = [];
      }
      continue;
    }
    if (/^```[ \t]*$/.test(line)) {
      const tag = TAG_PATTERN.exec(open.info);
      fences.push({
        lang: open.lang,
        info: open.info,
        group: tag?.[1],
        startLine: open.startLine,
        endLine: lineNumber,
        code: buffer.join("\n"),
      });
      open = undefined;
      continue;
    }
    buffer.push(line);
  }

  if (open !== undefined) {
    throw new Error(
      `${DOC_LABEL}: unterminated code fence opened at line ${open.startLine}`,
    );
  }
  return fences;
}

const fences = parseFences(readFileSync(DOC_PATH, "utf8"));
const tagged = fences.filter((fence) => fence.group !== undefined);
const untagged = fences.filter(
  (fence) => fence.group === undefined && EXECUTABLE_LANGS.has(fence.lang),
);

const groups = new Map<string, Fence[]>();
for (const fence of tagged) {
  const group = fence.group;
  if (group === undefined) continue;
  const existing = groups.get(group);
  if (existing) existing.push(fence);
  else groups.set(group, [fence]);
}

function buildSource(members: Fence[]): string {
  const body = members
    .map(
      (fence) =>
        `// ${DOC_LABEL}:${fence.startLine}-${fence.endLine}\n${fence.code}`,
    )
    .join("\n\n");
  const hasImport = /^\s*import\s/m.test(body);
  return `${hasImport ? "" : PREAMBLE}${body}\n`;
}

const WORKDIR_PREFIX = ".docs-snippets-";
const OWNED_WORKDIR_PREFIX = `${WORKDIR_PREFIX}${process.pid}-`;

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function cleanupStaleWorkdirs(): void {
  for (const entry of readdirSync(__dirname)) {
    if (!entry.startsWith(WORKDIR_PREFIX)) continue;
    const owner = /^\.docs-snippets-(\d+)-/.exec(entry);
    if (owner && processIsRunning(Number(owner[1]))) continue;
    rmSync(join(__dirname, entry), { recursive: true, force: true });
  }
}

beforeAll(cleanupStaleWorkdirs);

const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT_DIR,
  getNewLine: () => "\n",
};

const configPath = resolve(ROOT_DIR, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.formatDiagnostic(configFile.error, diagnosticHost));
}
const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  ROOT_DIR,
  {
    composite: false,
    declaration: false,
    emitDeclarationOnly: false,
    incremental: false,
    noEmit: true,
  },
  configPath,
);
if (parsedConfig.errors.length > 0) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(
      parsedConfig.errors,
      diagnosticHost,
    ),
  );
}
const compilerOptions: ts.CompilerOptions = {
  ...parsedConfig.options,
  typeRoots: [
    resolve(ROOT_DIR, "node_modules/@types"),
    resolve(ROOT_DIR, "packages/core/node_modules/@types"),
  ],
};

function typecheck(file: string): void {
  const program = ts.createProgram({
    rootNames: [file],
    options: compilerOptions,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost),
    );
  }
}

describe("executable documentation", () => {
  it("removes stale generated modules on startup", () => {
    const staleWorkdir = mkdtempSync(join(__dirname, WORKDIR_PREFIX));
    try {
      cleanupStaleWorkdirs();
      expect(existsSync(staleWorkdir)).toBe(false);
    } finally {
      rmSync(staleWorkdir, { recursive: true, force: true });
    }
  });

  it(`${DOC_LABEL} still carries the expected docs-run tags`, () => {
    const found: Record<string, number> = {};
    for (const [group, members] of groups) found[group] = members.length;
    expect(
      found,
      `The docs-run tags in ${DOC_LABEL} no longer match this file's ` +
        "EXPECTED_GROUPS pin. If a fence was intentionally added, removed or " +
        "retagged, update EXPECTED_GROUPS; otherwise the tags were lost and " +
        "the snippets below stopped being executed.",
    ).toEqual(EXPECTED_GROUPS);

    const wrongLang = tagged.filter(
      (fence) => !EXECUTABLE_LANGS.has(fence.lang),
    );
    expect(
      wrongLang.map((fence) => `${fence.lang}@${fence.startLine}`),
      "docs-run= is only supported on ts/typescript fences",
    ).toEqual([]);
  });

  for (const [group, members] of groups) {
    const ranges = members
      .map((fence) => `${fence.startLine}-${fence.endLine}`)
      .join(", ");
    it(`runs ${DOC_LABEL} [docs-run=${group}] (lines ${ranges})`, async () => {
      const source = buildSource(members);
      const workdir = mkdtempSync(join(__dirname, OWNED_WORKDIR_PREFIX));
      const file = join(workdir, `${group}.snippet.ts`);
      try {
        writeFileSync(file, source);
        typecheck(file);
        await expect(import(pathToFileURL(file).href)).resolves.toBeDefined();
      } catch (error) {
        throw new Error(
          `${DOC_LABEL} [docs-run=${group}] failed. Source built from lines ` +
            `${ranges}:\n\n${source}\n`,
          { cause: error },
        );
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    });
  }

  for (const fence of untagged) {
    const firstLine = fence.code.split("\n")[0] ?? "";
    it.skip(
      `skips ${DOC_LABEL}:${fence.startLine}-${fence.endLine} ` +
        `(no docs-run tag) — ${firstLine.trim().slice(0, 60)}`,
      () => {
        /* untagged fences are documentation prose, not executable */
      },
    );
  }
});
