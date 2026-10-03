export function unavailableValue(value: unknown): Record<string, string> {
  let type: string = typeof value;
  if (typeof value === "object" && value !== null) {
    try {
      type = Object.prototype.toString.call(value);
    } catch {
      type = "object";
    }
  }
  return {
    kind: "unavailable",
    reason: "not-structured-cloneable",
    type,
  };
}

function removeSharedMemory(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value !== "object" || value === null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    const copy = Uint8Array.from(new Uint8Array(value)).buffer;
    seen.set(value, copy);
    return copy;
  }

  if (
    ArrayBuffer.isView(value) &&
    typeof SharedArrayBuffer !== "undefined" &&
    value.buffer instanceof SharedArrayBuffer
  ) {
    const copy = Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
    seen.set(value, copy);
    return copy;
  }

  seen.set(value, value);
  if (value instanceof Map) {
    const entries = [...value.entries()];
    value.clear();
    for (const [key, entryValue] of entries) {
      value.set(
        removeSharedMemory(key, seen),
        removeSharedMemory(entryValue, seen),
      );
    }
    return value;
  }
  if (value instanceof Set) {
    const entries = [...value.values()];
    value.clear();
    for (const entryValue of entries) {
      value.add(removeSharedMemory(entryValue, seen));
    }
    return value;
  }

  for (const key of Reflect.ownKeys(value)) {
    Reflect.set(value, key, removeSharedMemory(Reflect.get(value, key), seen));
  }
  return value;
}

export function snapshotValue(value: unknown): unknown {
  try {
    return removeSharedMemory(structuredClone(value));
  } catch {
    return unavailableValue(value);
  }
}

/**
 * Snapshot a body that already went through `normalizeResponse`.
 *
 * A normalized body is a string, a `JSON.parse` tree or a fresh byte copy, so
 * it can never hold shared memory: the `removeSharedMemory` walk that caller
 * supplied values need would only re-visit every node for nothing.
 */
export function snapshotNormalizedBody(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return unavailableValue(value);
  }
}

/**
 * Snapshot a request body as a transport read it. A `FormData` is copied entry
 * by entry, since `structuredClone` cannot copy one.
 */
export function snapshotRequestBody(body: unknown): unknown {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    try {
      const copy = new FormData();
      for (const [key, value] of body.entries()) copy.append(key, value);
      return copy;
    } catch {
      return unavailableValue(body);
    }
  }
  return snapshotValue(body);
}
