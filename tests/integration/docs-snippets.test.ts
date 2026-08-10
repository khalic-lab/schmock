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
 * module, which is written to a temporary `.ts` file inside this directory and
 * imported (vitest resolves `@schmock/core` & co. to `packages/*\/src` via
 * tests/integration/vitest.config.ts). One rule applies to the concatenated
 * source: if it contains no top-level `import`, a single
 * `import { schmock } from "@schmock/core"` preamble is prepended. Nothing else
 * is injected. That is why a group's FIRST fence must be the one that creates
 * the mock instance the later fences use.
 *
 * What this does and does not prove
 * ---------------------------------
 * - It proves the snippets still execute: renamed methods, changed signatures,
 *   and construction-time throws all fail here.
 * - It does NOT typecheck: esbuild strips annotations without checking them.
 * - It does NOT inspect response status codes. `mock.handle()` resolves with a
 *   500/404 response object rather than throwing, so a snippet whose generator
 *   blows up inside the pipeline still passes. Groups are therefore built as
 *   coherent sessions (see the untagged fences: a snippet that depends on state
 *   an earlier tagged fence never creates is deliberately left out).
 *
 * EXPECTED_GROUPS below pins the tags this file expects to find. If a doc edit
 * drops or renames a tag, the pin fails loudly — otherwise losing the tags
 * would leave this suite green with nothing to run.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DOC_LABEL = "docs/getting-started.md";
const DOC_PATH = resolve(__dirname, "../..", DOC_LABEL);

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
          lang: match[1] as string,
          info: (match[2] as string).trim(),
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
  const group = fence.group as string;
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

let workdir: string;

beforeAll(() => {
  // Generated modules live inside this directory so vitest's `@schmock/*`
  // aliases resolve; a crashed earlier run can leave one behind, so sweep first.
  for (const entry of readdirSync(__dirname)) {
    if (entry.startsWith(WORKDIR_PREFIX)) {
      rmSync(join(__dirname, entry), { recursive: true, force: true });
    }
  }
  workdir = mkdtempSync(join(__dirname, WORKDIR_PREFIX));
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("executable documentation", () => {
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
      const file = join(workdir, `${group}.snippet.ts`);
      writeFileSync(file, source);
      try {
        await expect(import(pathToFileURL(file).href)).resolves.toBeDefined();
      } catch (error) {
        throw new Error(
          `${DOC_LABEL} [docs-run=${group}] failed. Source built from lines ` +
            `${ranges}:\n\n${source}\n`,
          { cause: error },
        );
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
