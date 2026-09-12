import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "check-formatter-only.sh");

/**
 * A stand-in formatter, so the test proves the script's logic rather than
 * Biome's formatting decisions: it strips trailing whitespace and collapses
 * runs of blank lines. Deterministic, and no network or node_modules.
 */
const STUB_FORMATTER = `#!/usr/bin/env bash
sed -e 's/[[:space:]]*$//' | cat -s
`;

let repo: string;
let stub: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function run(args: string[]): { output: string; exitCode: number } {
  try {
    const output = execFileSync("bash", [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, FORMATTER_CMD: stub },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { output, exitCode: 0 };
  } catch (e: any) {
    return {
      output: (e.stdout || "") + (e.stderr || ""),
      exitCode: e.status ?? 1,
    };
  }
}

/** What the stub formatter turns `source` into. */
function formatted(source: string): string {
  return execFileSync("bash", [stub], { input: source, encoding: "utf-8" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "fmt-only-"));
  stub = join(repo, "stub-formatter.sh");
  writeFileSync(stub, STUB_FORMATTER);
  chmodSync(stub, 0o755);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);

  // Base: two files the stub formatter would change (trailing space, blank runs).
  const reflowBase = "export const a = 1;   \n\n\n\nexport const b = 2;\n";
  const semanticBase = "export const threshold = 10;   \n\n\n\nexport const on = true;\n";
  writeFileSync(join(repo, "reflow.ts"), reflowBase);
  writeFileSync(join(repo, "semantic.ts"), semanticBase);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);

  // Head: reflow.ts is exactly the formatter's output — pure reflow.
  writeFileSync(join(repo, "reflow.ts"), formatted(reflowBase));
  // semantic.ts is the formatter's output PLUS one changed value — the edit
  // hiding inside the churn.
  writeFileSync(
    join(repo, "semantic.ts"),
    formatted(semanticBase).replace("threshold = 10", "threshold = 99"),
  );
  // A file that only exists at head.
  writeFileSync(join(repo, "added.ts"), "export const c = 3;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "head"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-formatter-only.sh", () => {
  it("classifies pure reflow as formatter-only", () => {
    const { output } = run(["HEAD~1", "HEAD", "*.ts"]);
    const reflowSection = output.split("semantic change")[0];
    expect(reflowSection).toContain("reflow.ts");
    expect(output).toContain("formatter-only");
  });

  it("flags a semantic edit hidden inside formatter churn", () => {
    const { output, exitCode } = run(["HEAD~1", "HEAD", "*.ts"]);
    expect(output).toContain("semantic change");
    // The discriminating fact: semantic.ts is listed as needing review.
    const flagged = output.split("semantic change")[1] ?? "";
    expect(flagged).toContain("semantic.ts");
    expect(flagged).not.toContain("reflow.ts");
    expect(exitCode).toBe(1);
  });

  it("reports an added file separately rather than as a semantic change", () => {
    const { output } = run(["HEAD~1", "HEAD", "*.ts"]);
    const added = output.split("added (no base content")[1] ?? "";
    expect(added).toContain("added.ts");
  });

  it("exits 0 when every changed file is formatter-only", () => {
    const { exitCode, output } = run(["HEAD~1", "HEAD", "reflow.ts"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("reflow only");
  });

  it("exits 2 on missing arguments", () => {
    expect(run([]).exitCode).toBe(2);
    expect(run(["HEAD~1"]).exitCode).toBe(2);
  });

  it("exits 2 on a ref that is not a commit", () => {
    const { exitCode, output } = run(["HEAD~1", "no-such-ref"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("Not a commit");
  });
});
