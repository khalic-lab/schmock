import { EventEmitter } from "node:events";
import {
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schmock } from "@schmock/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MockHolder, startWatch, type WatchHandle } from "./watch";

// `watch` stays the real one unless a test stands in for the file system, so
// it can deliver exactly the events it means to, in order, with no timing.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

type WatchListener = (event: string, filename: string | null) => void;

/** Replace `fs.watch` with watchers whose events the test fires by hand. */
function fakeWatches(): Map<string, WatchListener> {
  const listeners = new Map<string, WatchListener>();
  vi.mocked(watch).mockImplementation(((
    directory: string,
    listener: WatchListener,
  ) => {
    listeners.set(String(directory), listener);
    return Object.assign(new EventEmitter(), {
      close: () => {},
    }) as unknown as FSWatcher;
  }) as unknown as typeof watch);
  return listeners;
}

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

describe("startWatch", () => {
  let handle: WatchHandle | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks();
    vi.mocked(watch).mockReset();
    vi.useRealTimers();
  });

  // The openapi plugin reads a file: URL spec, so --watch must watch the file
  // it names rather than resolve the URL as a relative path under the cwd.
  // The scheme is case-insensitive (RFC 3986), so FILE: names a file too.
  it.each([
    ["file:", (href: string) => href],
    ["FILE:", (href: string) => href.replace(/^file:/, "FILE:")],
  ])("watches the file a %s URL spec names", async (_scheme, spell) => {
    directory = mkdtempSync(join(tmpdir(), "schmock-watch-url-"));
    // A space and a non-ASCII letter are percent-encoded in the URL, so only
    // a real URL-to-path conversion finds the directory.
    const specDirectory = join(directory, "my specs \u00e9");
    mkdirSync(specDirectory);
    const specPath = join(specDirectory, "api.json");
    const spec = readFileSync(PETSTORE_SPEC, "utf8");
    writeFileSync(specPath, spec);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const holder: MockHolder = { mock: schmock() };
    const rebuild = vi.fn(async () => schmock());
    handle = startWatch({
      options: { spec: spell(pathToFileURL(specPath).href), watch: true },
      holder,
      rebuild,
      url: "http://127.0.0.1:0",
    });

    writeFileSync(specPath, `${spec}\n`);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalled(), {
      timeout: 4_000,
      interval: 50,
    });
  });

  // Only the spec file's own events reload: the watch is on the directory
  // that holds the spec, so a write to an unrelated sibling there is skipped.
  it("reloads on the spec a file: URL names and not on its siblings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listeners = fakeWatches();
    const specDirectory = join(tmpdir(), "schmock watch \u00e9", "specs");
    const specPath = join(specDirectory, "api.json");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const rebuild = vi.fn(async () => schmock());
    handle = startWatch({
      options: { spec: pathToFileURL(specPath).href, watch: true },
      holder: { mock: schmock() },
      rebuild,
      url: "http://127.0.0.1:0",
    });

    expect([...listeners.keys()]).toEqual([specDirectory]);
    const fire = listeners.get(specDirectory);
    fire?.("change", "notes.txt");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebuild).not.toHaveBeenCalled();

    fire?.("change", "api.json");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  // "#" and "?" are percent-encoded in a file: URL and only a full URL-to-path
  // conversion decodes them; decoding the pathname as a URI leaves "%23".
  it("watches the directory a file: URL names with an encoded # in it", () => {
    const listeners = fakeWatches();
    const specDirectory = join(tmpdir(), "schmock #1 ?", "specs");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    handle = startWatch({
      options: {
        spec: pathToFileURL(join(specDirectory, "api.json")).href,
        watch: true,
      },
      holder: { mock: schmock() },
      rebuild: vi.fn(async () => schmock()),
      url: "http://127.0.0.1:0",
    });

    expect([...listeners.keys()]).toEqual([specDirectory]);
  });

  // A file: URL Node cannot turn into a path (a remote host, an encoded "/")
  // is watched as a path, as before the fix, rather than failing the start.
  it.each([
    "file://remote-host/specs/api.json",
    "file:///specs/a%2Fb/api.json",
  ])("watches %s as a path when it names no local file", (spec) => {
    const listeners = fakeWatches();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    handle = startWatch({
      options: { spec, watch: true },
      holder: { mock: schmock() },
      rebuild: vi.fn(async () => schmock()),
      url: "http://127.0.0.1:0",
    });

    expect([...listeners.keys()]).toEqual([dirname(resolve(spec))]);
  });
});
