import { describe, expect, it } from "vitest";
import { schmock } from "./index";
import { snapshotValue } from "./snapshot";

// Past 2^24 elements V8's Reflect.ownKeys throws "Too many properties to
// enumerate", so a snapshot that walks a typed array index by index records
// it as unavailable instead of copying it.
const PAST_INDEX_WALK_LIMIT = 2 ** 24 + 1;

describe("snapshotValue", () => {
  describe("binary values", () => {
    it("copies a typed array without walking its indices", () => {
      const source = new Uint8Array(PAST_INDEX_WALK_LIMIT);
      source[PAST_INDEX_WALK_LIMIT - 1] = 7;

      const copy = snapshotValue(source);

      expect(copy).toBeInstanceOf(Uint8Array);
      if (!(copy instanceof Uint8Array)) return;
      // Identity only: .not.toBe() deep-compares 16 MiB to explain a pass.
      expect(copy === source).toBe(false);
      expect(copy.byteLength).toBe(PAST_INDEX_WALK_LIMIT);
      expect(copy[PAST_INDEX_WALK_LIMIT - 1]).toBe(7);
    });

    it("keeps a typed array nested in an object a private copy", () => {
      const bytes = Uint8Array.of(1, 2, 3);
      const copy = snapshotValue({ file: bytes });

      bytes.fill(0);

      expect(copy).toEqual({ file: Uint8Array.of(1, 2, 3) });
    });

    it("copies a DataView with its window", () => {
      const view = new DataView(Uint8Array.of(1, 2, 3, 4).buffer, 1, 2);
      const copy = snapshotValue(view);

      expect(copy).toBeInstanceOf(DataView);
      if (!(copy instanceof DataView)) return;
      expect(copy.byteLength).toBe(2);
      expect(copy.getUint8(0)).toBe(2);
    });
  });
});

describe("request history of binary bodies", () => {
  it("records a large typed-array body byte for byte", async () => {
    const mock = schmock();
    mock("POST /upload", [201, { ok: true }]);
    const body = new Uint8Array(PAST_INDEX_WALK_LIMIT);
    body[0] = 1;
    body[PAST_INDEX_WALK_LIMIT - 1] = 2;

    const response = await mock.handle("POST", "/upload", { body });
    const recorded = mock.lastRequest()?.body;

    expect(response.status).toBe(201);
    expect(recorded).toBeInstanceOf(Uint8Array);
    if (!(recorded instanceof Uint8Array)) return;
    expect(recorded.byteLength).toBe(PAST_INDEX_WALK_LIMIT);
    expect(recorded[0]).toBe(1);
    expect(recorded[PAST_INDEX_WALK_LIMIT - 1]).toBe(2);
  });
});
