import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function peerRange(manifestPath: string, name: string): string | undefined {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("peerDependencies" in manifest) ||
    typeof manifest.peerDependencies !== "object" ||
    manifest.peerDependencies === null ||
    !(name in manifest.peerDependencies)
  ) {
    return undefined;
  }
  const range: unknown = Reflect.get(manifest.peerDependencies, name);
  return typeof range === "string" ? range : undefined;
}

describe("@schmock/angular peer ranges", () => {
  it("accepts every rxjs Angular itself accepts", () => {
    // The adapter uses only Observable and Subscriber, which every rxjs
    // Angular 15-22 supports provides. A narrower range (the ^7.8.2 a
    // dependency sweep once set) makes npm refuse an Angular 15.0 app
    // scaffolded with rxjs ~7.5.0. The floor is the rxjs peer of the oldest
    // Angular the adapter supports (@angular/common 15, "^6.5.3 || ^7.4.0"),
    // so it is pinned as a literal: comparing it with the installed
    // @angular/common would narrow it whenever a newer Angular drops rxjs 6,
    // although the adapter still accepts @angular/core 15.
    const own = peerRange(
      resolve(import.meta.dirname, "..", "package.json"),
      "rxjs",
    );

    expect(own).toBe("^6.5.3 || ^7.4.0");
  });
});
