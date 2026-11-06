import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSpecForDisplay } from "./redact-url";
import type { CliOptions, CliServer } from "./types";

/**
 * The banner is what `run` prints once the server is up. The server itself is
 * stubbed: what is under test is the text, and a spec URL would otherwise
 * need the network to load.
 */
const started = vi.hoisted(() => ({ options: [] as CliOptions[] }));

vi.mock("./server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server.js")>();
  return {
    ...actual,
    createCliServer: async (options: CliOptions): Promise<CliServer> => {
      started.options.push(options);
      return {
        server: undefined as unknown as CliServer["server"],
        port: 3000,
        hostname: "127.0.0.1",
        close: async () => {},
      };
    },
  };
});

const { run } = await import("./cli");

async function bannerOf(args: string[]): Promise<string> {
  const baseline = process.listeners("SIGINT");
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const finished = run(args);
  await vi.waitFor(() => expect(stderr).toContain("Schmock server running"));
  const added = process
    .listeners("SIGINT")
    .filter((listener) => !baseline.includes(listener));
  added[0]?.("SIGINT");
  await finished;
  return stderr;
}

afterEach(() => {
  vi.restoreAllMocks();
  started.options = [];
});

describe("the spec line in the startup banner", () => {
  it("masks a password and credential query parameters in a spec URL", async () => {
    const spec =
      "https://ci:hunter2@specs.example.com/api.json?api_key=K3Y&rev=7";
    const stderr = await bannerOf([spec]);

    // The server still gets the URL as given.
    expect(started.options[0]?.spec).toBe(spec);
    expect(stderr).toContain(
      "Spec: https://ci:[redacted]@specs.example.com/api.json?api_key=[redacted]&rev=7\n",
    );
    expect(stderr).not.toMatch(/hunter2|K3Y/);
  });

  it("prints a local path unchanged", async () => {
    const stderr = await bannerOf(["specs/api_key=1.json"]);
    expect(stderr).toContain("Spec: specs/api_key=1.json\n");
  });
});

describe("redactSpecForDisplay", () => {
  it.each([
    ["api.yaml", "api.yaml"],
    ["http://host/a.json", "http://host/a.json"],
    ["http://user@host/a.json", "http://user@host/a.json"],
    ["https://u:p@host", "https://u:[redacted]@host"],
    // WHATWG URL parsing takes the LAST "@" as the end of the userinfo, so a
    // raw "@" in the password is part of the password and is masked with it.
    ["https://u:p@ss@host/a", "https://u:[redacted]@host/a"],
    // The user name ends at the FIRST ":", so a ":" in the password is masked.
    ["https://u:p:q@host/a", "https://u:[redacted]@host/a"],
    // The scheme is case-insensitive (RFC 3986), so an upper-case one is a URL.
    [
      "HTTPS://u:p@host/a?Token=t",
      "HTTPS://u:[redacted]@host/a?Token=[redacted]",
    ],
    [
      "https://host/a.json?q=a%20b#token=x",
      "https://host/a.json?q=a%20b#token=x",
    ],
    ["https://host?access_token=t", "https://host?access_token=[redacted]"],
    ["https://h/a?x=1&token=t#f", "https://h/a?x=1&token=[redacted]#f"],
    ["https://h/a?api%5Fkey=k", "https://h/a?api%5Fkey=[redacted]"],
    ["https://h/a?%E0%A4%A_token=t", "https://h/a?%E0%A4%A_token=[redacted]"],
  ])("shows %j as %j", (spec, shown) => {
    expect(redactSpecForDisplay(spec)).toBe(shown);
  });
});
