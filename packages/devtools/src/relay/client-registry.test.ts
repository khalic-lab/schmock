import { describe, expect, it } from "vitest";
import { ClientRegistry } from "./client-registry.js";
import type { CacheStorageLike } from "./types.js";

const cacheName = "test-cache";
const key = "http://localhost/__schmock-relay/clients";

interface PutRecord {
  key: string;
  body: string;
  contentType: string | null;
}

interface FakeStorage {
  storage: CacheStorageLike;
  data: Map<string, Map<string, string>>;
  opened: string[];
  puts: PutRecord[];
  rejectOpen: boolean;
  rejectMatch: boolean;
  rejectPut: boolean;
  firstPutGate: Promise<void> | undefined;
  stored(): unknown;
}

function createFakeStorage(seed?: string): FakeStorage {
  const fake: FakeStorage = {
    data: new Map(),
    opened: [],
    puts: [],
    rejectOpen: false,
    rejectMatch: false,
    rejectPut: false,
    firstPutGate: undefined,
    stored() {
      const raw = fake.data.get(cacheName)?.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    storage: {
      async open(name) {
        fake.opened.push(name);
        if (fake.rejectOpen) throw new Error("open denied");
        let entries = fake.data.get(name);
        if (entries === undefined) {
          entries = new Map();
          fake.data.set(name, entries);
        }
        const bucket = entries;
        return {
          async match(k) {
            if (fake.rejectMatch) throw new Error("match denied");
            const body = bucket.get(k);
            return body === undefined ? undefined : new Response(body);
          },
          async put(k, response) {
            const gate = fake.puts.length === 0 ? fake.firstPutGate : undefined;
            const body = await response.text();
            fake.puts.push({
              key: k,
              body,
              contentType: response.headers.get("content-type"),
            });
            if (gate !== undefined) await gate;
            if (fake.rejectPut) throw new Error("put denied");
            bucket.set(k, body);
          },
        };
      },
    },
  };
  if (seed !== undefined) {
    fake.data.set(cacheName, new Map([[key, seed]]));
  }
  return fake;
}

describe("ClientRegistry loading", () => {
  it("R1 reports loaded only after ready resolves", async () => {
    const fake = createFakeStorage();
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    expect(registry.loaded).toBe(false);
    await registry.ready;
    expect(registry.loaded).toBe(true);
  });

  it("R2 has() is false before load whatever is stored, true after", async () => {
    const fake = createFakeStorage('["a"]');
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    expect(registry.has("a")).toBe(false);
    await registry.ready;
    expect(registry.has("a")).toBe(true);
    expect(registry.has("zzz")).toBe(false);
  });
});

describe("ClientRegistry writes", () => {
  it("R3 add persists a JSON array under the key", async () => {
    const fake = createFakeStorage();
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await registry.add("a");
    expect(fake.opened).toContain("test-cache");
    expect(fake.stored()).toEqual(["a"]);
    expect(fake.puts[0]?.key).toBe(key);
    expect(fake.puts[0]?.contentType).toBe("application/json");
    expect(registry.has("a")).toBe(true);
  });

  it("R4 delete removes the id durably", async () => {
    const fake = createFakeStorage();
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await registry.add("a");
    await registry.add("b");
    await registry.delete("a");
    expect(fake.stored()).toEqual(["b"]);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });

  it("R5 serializes writes issued without awaiting", async () => {
    const fake = createFakeStorage();
    let release: () => void = () => {};
    fake.firstPutGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    const p1 = registry.add("a");
    const p2 = registry.add("b");
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([p1, p2]);
    expect(fake.stored()).toEqual(["a", "b"]);
    expect(fake.puts).toHaveLength(2);
    expect(JSON.parse(fake.puts[1]?.body ?? "null")).toEqual(["a", "b"]);
  });

  it("R6 a new instance over the same storage sees prior ids", async () => {
    const fake = createFakeStorage();
    const first = new ClientRegistry(fake.storage, cacheName, key);
    await first.add("a");
    await first.add("b");
    const second = new ClientRegistry(fake.storage, cacheName, key);
    await second.ready;
    expect(second.has("a")).toBe(true);
    expect(second.has("b")).toBe(true);
    expect(second.has("c")).toBe(false);
  });

  it("R7 retain keeps only the live ids, durably", async () => {
    const fake = createFakeStorage();
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await registry.add("a");
    await registry.add("b");
    await registry.add("c");
    await registry.retain(["b"]);
    expect(fake.stored()).toEqual(["b"]);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    const next = new ClientRegistry(fake.storage, cacheName, key);
    await next.ready;
    expect(next.has("b")).toBe(true);
    expect(next.has("a")).toBe(false);
    expect(next.has("c")).toBe(false);
  });

  it("R8 an operation issued before ready is applied after the load", async () => {
    const fake = createFakeStorage('["a"]');
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await registry.add("b");
    expect(fake.stored()).toEqual(["a", "b"]);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
  });

  it("R14 opens the cache exactly once across writes", async () => {
    const fake = createFakeStorage();
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await registry.add("a");
    await registry.add("b");
    await registry.delete("a");
    expect(fake.puts).toHaveLength(3);
    expect(fake.opened).toEqual(["test-cache"]);
  });
});

describe("ClientRegistry memory-only fallbacks", () => {
  it("R9 works with undefined storage", async () => {
    const registry = new ClientRegistry(undefined, cacheName, key);
    await expect(registry.ready).resolves.toBeUndefined();
    await expect(registry.add("a")).resolves.toBeUndefined();
    expect(registry.has("a")).toBe(true);
    expect(registry.loaded).toBe(true);
  });

  it("R10 open() rejecting leaves a memory-only registry", async () => {
    const fake = createFakeStorage();
    fake.rejectOpen = true;
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await expect(registry.ready).resolves.toBeUndefined();
    await expect(registry.add("a")).resolves.toBeUndefined();
    expect(registry.has("a")).toBe(true);
    expect(fake.puts).toHaveLength(0);
  });

  it("R11 match() rejecting leaves a memory-only registry", async () => {
    const fake = createFakeStorage('["old"]');
    fake.rejectMatch = true;
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await expect(registry.ready).resolves.toBeUndefined();
    expect(registry.has("old")).toBe(false);
    await registry.add("a");
    expect(registry.has("a")).toBe(true);
    expect(fake.puts).toHaveLength(0);
  });

  it("R12 put() rejecting stops further writes but keeps memory", async () => {
    const fake = createFakeStorage();
    fake.rejectPut = true;
    const registry = new ClientRegistry(fake.storage, cacheName, key);
    await expect(registry.add("a")).resolves.toBeUndefined();
    expect(registry.has("a")).toBe(true);
    expect(fake.puts).toHaveLength(1);
    await registry.add("b");
    expect(fake.puts).toHaveLength(1);
    expect(registry.has("b")).toBe(true);
  });
});

describe("ClientRegistry garbage storage", () => {
  it.each([
    ["not json", "not json", []],
    ["a JSON object", '{"a":1}', []],
    ["mixed array", '[1,"x"]', ["x"]],
  ])(
    "R13 reads %s defensively and keeps writing",
    async (_label, seed, expected) => {
      const fake = createFakeStorage(seed);
      const registry = new ClientRegistry(fake.storage, cacheName, key);
      await registry.ready;
      for (const id of ["x", "1"]) {
        expect(registry.has(id)).toBe(expected.includes(id));
      }
      await registry.add("n");
      expect(fake.puts).toHaveLength(1);
      expect(fake.stored()).toEqual([...expected, "n"]);
    },
  );
});
