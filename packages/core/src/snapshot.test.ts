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
  it("keeps the type of a view over shared memory", async () => {
    const mock = schmock();
    mock("POST /upload", [201, { ok: true }]);
    const shorts = new Int16Array(new SharedArrayBuffer(8));
    shorts[0] = 1000;
    const doubles = new Float64Array(new SharedArrayBuffer(8));
    doubles[0] = 1.5;
    const view = new DataView(new SharedArrayBuffer(4));
    view.setUint16(0, 513);

    await mock.handle("POST", "/upload", {
      body: { shorts, doubles, view },
    });
    const recorded = mock.lastRequest()?.body;

    expect(recorded).toMatchObject({
      shorts: expect.any(Int16Array),
      doubles: expect.any(Float64Array),
      view: expect.any(DataView),
    });
    if (typeof recorded !== "object" || recorded === null) return;
    const copy = recorded as Record<string, ArrayBufferView>;
    expect(Array.from(copy.shorts as Int16Array)).toEqual([1000, 0, 0, 0]);
    expect(Array.from(copy.doubles as Float64Array)).toEqual([1.5]);
    expect((copy.view as DataView).getUint16(0)).toBe(513);
    for (const value of Object.values(copy)) {
      expect(value.buffer instanceof SharedArrayBuffer).toBe(false);
    }
  });

  it("copies only the bytes a view over shared memory spans", async () => {
    const mock = schmock();
    mock("POST /upload", [201, { ok: true }]);
    const shared = new SharedArrayBuffer(16);
    new Int16Array(shared).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const shorts = new Int16Array(shared, 4, 2);
    const view = new DataView(shared, 2, 4);

    await mock.handle("POST", "/upload", { body: { shorts, view } });
    const recorded = mock.lastRequest()?.body;

    expect(recorded).toMatchObject({
      shorts: expect.any(Int16Array),
      view: expect.any(DataView),
    });
    if (typeof recorded !== "object" || recorded === null) return;
    const copy = recorded as Record<string, ArrayBufferView>;
    const copiedShorts = copy.shorts as Int16Array;
    expect(Array.from(copiedShorts)).toEqual([3, 4]);
    expect(copiedShorts.byteOffset).toBe(0);
    expect(copiedShorts.buffer.byteLength).toBe(4);
    const copiedView = copy.view as DataView;
    expect(copiedView.byteLength).toBe(4);
    expect(copiedView.getInt16(0, true)).toBe(2);
    expect(copiedView.getInt16(2, true)).toBe(3);
  });

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
