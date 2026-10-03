import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schmock } from "@schmock/core";
import { devtoolsPlugin, startServiceWorkerRelay } from "@schmock/devtools";

// Render console format args as a console shows them: `%c` takes an argument
// and prints nothing, `%s` prints `String(arg)`, leftover arguments follow
// after a space. Only the format string is scanned, never substituted text.
function renderConsole(args: readonly unknown[]): string {
  const [format, ...rest] = args;
  if (typeof format !== "string") return args.map(String).join(" ");
  const text = format.replace(/%[cs]/g, (directive) => {
    if (rest.length === 0) return directive;
    const arg = rest.shift();
    return directive === "%c" ? "" : String(arg);
  });
  return [text, ...rest.map(String)].join(" ");
}

const titles: string[] = [];
const originalGroupCollapsed = console.groupCollapsed;
console.groupCollapsed = (...args: unknown[]) => {
  titles.push(renderConsole(args));
};

const mock = schmock();
mock.pipe(devtoolsPlugin());
mock("GET /items", [{ id: 1 }]);
const lease = mock.intercept();

try {
  const response = await fetch("http://localhost/items");
  if (response.status !== 200) throw new Error("Status: " + response.status);
  await response.json();

  if (titles.length !== 1) throw new Error("Console groups: " + titles.length);
  if (!titles[0].startsWith("Schmock GET http://localhost/items → 200")) {
    throw new Error("Group title: " + titles[0]);
  }

  const measures = performance.getEntriesByType("measure").filter((entry) => {
    const detail = (entry as PerformanceMeasure).detail as {
      devtools?: { track?: string };
    } | null;
    return detail?.devtools?.track === "Schmock";
  });
  if (measures.length !== 1)
    throw new Error("Track entries: " + measures.length);
} finally {
  lease.restore();
  console.groupCollapsed = originalGroupCollapsed;
}

// Node has no service workers: the relay falls back with one warning.
const originalWarn = console.warn;
let warnings = 0;
console.warn = () => {
  warnings += 1;
};
try {
  const relay = await startServiceWorkerRelay();
  if (relay.fallbackReason !== "unsupported") {
    throw new Error("Relay fallback: " + relay.fallbackReason);
  }
  if (warnings !== 1) throw new Error("Relay warnings: " + warnings);
} finally {
  console.warn = originalWarn;
}

// The entry is dist/index.js when installed, so its grandparent is the package.
const packageDir = dirname(
  dirname(fileURLToPath(import.meta.resolve("@schmock/devtools"))),
);
for (const file of ["dist/schmock-sw.js", "dist/bin.js"]) {
  if (!existsSync(join(packageDir, file))) throw new Error("Missing " + file);
}

console.log("@schmock/devtools: all checks passed");
