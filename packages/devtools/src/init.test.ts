import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";

const USAGE = "Usage: schmock-devtools init <publicDir>\n";
const NEXT =
  'Next: call "await startServiceWorkerRelay()" from @schmock/devtools before your app renders.\n';
const WORKER_BYTES = "// schmock worker éè ☃ \u{1F680}\nconsole.log(1);\n";

describe("runInit", () => {
  let cwd: string;
  let pkgDir: string;
  let source: string;
  let out: string[];
  let err: string[];
  const extraDirs: string[] = [];

  const io = () => ({
    cwd,
    source,
    stdout: (t: string) => {
      out.push(t);
    },
    stderr: (t: string) => {
      err.push(t);
    },
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "schmock-init-cwd-"));
    pkgDir = mkdtempSync(join(tmpdir(), "schmock-init-pkg-"));
    source = join(pkgDir, "schmock-sw.js");
    writeFileSync(source, WORKER_BYTES);
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
    for (const d of extraDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("copies the worker into <dir> and reports it (I1, I10)", () => {
    const code = runInit(["init", "public"], io());

    expect(typeof code).toBe("number");
    expect(code).toBe(0);
    expect(
      readFileSync(join(cwd, "public", "schmock-sw.js")).equals(
        readFileSync(source),
      ),
    ).toBe(true);
    expect(out.join("")).toBe(
      `Copied schmock-sw.js to ${join("public", "schmock-sw.js")}\n${NEXT}`,
    );
    expect(err).toEqual([]);
  });

  it("creates nested directories recursively (I2)", () => {
    expect(runInit(["init", "static/assets"], io())).toBe(0);
    expect(
      readFileSync(join(cwd, "static", "assets", "schmock-sw.js"), "utf8"),
    ).toBe(WORKER_BYTES);
  });

  it("overwrites an existing worker file (I3)", () => {
    mkdirSync(join(cwd, "public"));
    writeFileSync(join(cwd, "public", "schmock-sw.js"), "old worker");

    expect(runInit(["init", "public"], io())).toBe(0);
    expect(readFileSync(join(cwd, "public", "schmock-sw.js"), "utf8")).toBe(
      WORKER_BYTES,
    );
  });

  it("accepts an absolute directory (I4)", () => {
    const other = mkdtempSync(join(tmpdir(), "schmock-init-abs-"));
    extraDirs.push(other);

    expect(runInit(["init", other], io())).toBe(0);
    expect(readFileSync(join(other, "schmock-sw.js"), "utf8")).toBe(
      WORKER_BYTES,
    );
  });

  it.each([
    [[]],
    [["init"]],
    [["init", "a", "b"]],
    [["serve", "public"]],
    [["init", ""]],
  ])("prints usage on stderr and returns 1 for %j (I5)", (argv) => {
    const code = runInit(argv, io());

    expect(code).toBe(1);
    expect(err.join("")).toBe(USAGE);
    expect(out).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it.each([[["--help"]], [["-h"]], [["init", "--help"]]])(
    "prints usage on stdout and returns 0 for %j (I6)",
    (argv) => {
      const code = runInit(argv, io());

      expect(code).toBe(0);
      expect(out.join("")).toBe(USAGE);
      expect(err).toEqual([]);
    },
  );

  it("reports a missing source verbatim and creates nothing (I7)", () => {
    source = join(pkgDir, "nope", "schmock-sw.js");

    const code = runInit(["init", "public"], io());

    expect(code).toBe(1);
    expect(err.join("")).toBe(
      `Cannot find the packaged worker at ${source}. Reinstall @schmock/devtools.\n`,
    );
    expect(err.join("")).toContain(source);
    expect(out).toEqual([]);
    expect(existsSync(join(cwd, "public"))).toBe(false);
  });

  it("reports a copy failure without throwing (I8)", () => {
    writeFileSync(join(cwd, "public"), "i am a file");

    let code = -1;
    expect(() => {
      code = runInit(["init", "public"], io());
    }).not.toThrow();

    expect(code).toBe(1);
    expect(
      err
        .join("")
        .startsWith(
          `Could not copy schmock-sw.js to ${join("public", "schmock-sw.js")}: `,
        ),
    ).toBe(true);
    expect(err.join("").endsWith("\n")).toBe(true);
    expect(out).toEqual([]);
  });

  it("never touches process globals (I9)", () => {
    const cwdSpy = vi.spyOn(process, "cwd");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const stderrSpy = vi.spyOn(process.stderr, "write");
    const exitCodeBefore = process.exitCode;

    const code = runInit(["init", "public"], io());

    expect(code).toBe(0);
    expect(existsSync(join(cwd, "public", "schmock-sw.js"))).toBe(true);
    expect(cwdSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it("writes the two success lines as separate stdout calls", () => {
    expect(runInit(["init", "public"], io())).toBe(0);
    expect(out).toEqual([
      `Copied schmock-sw.js to ${join("public", "schmock-sw.js")}\n`,
      NEXT,
    ]);
  });
});
