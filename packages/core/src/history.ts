import { canonicalizePath, normalizePath } from "./constants.js";
import { SchmockError } from "./errors.js";

function unavailableHistoryValue(value: unknown): Record<string, string> {
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

/**
 * Reject a history limit that cannot bound anything.
 *
 * A negative limit used to read as "unbounded" and a fractional one evicted a
 * fractional number of records, so a typo silently disabled the cap instead of
 * failing. `Number.isInteger` also rejects NaN and Infinity. `0` stays valid
 * and keeps meaning "history disabled".
 */
function assertValidHistoryLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new SchmockError(
      `Invalid maxHistorySize: ${String(limit)}. Expected a non-negative integer (0 disables history).`,
      "INVALID_CONFIG",
      { maxHistorySize: limit },
    );
  }
}

function snapshotHistoryValue(value: unknown): unknown {
  try {
    return removeSharedMemory(structuredClone(value));
  } catch {
    return unavailableHistoryValue(value);
  }
}

/**
 * Snapshot a body that already went through `normalizeResponse`.
 *
 * A normalized body is a string, a `JSON.parse` tree or a fresh byte copy, so
 * it can never hold shared memory: the `removeSharedMemory` walk that caller
 * supplied values need would only re-visit every node for nothing.
 */
function snapshotNormalizedBody(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return unavailableHistoryValue(value);
  }
}

function cloneRecord(r: Schmock.RequestRecord): Schmock.RequestRecord {
  return {
    method: r.method,
    path: r.path,
    params: { ...r.params },
    query: { ...r.query },
    headers: { ...r.headers },
    body: snapshotHistoryValue(r.body),
    timestamp: r.timestamp,
    response: {
      status: r.response.status,
      body: snapshotNormalizedBody(r.response.body),
    },
  };
}

/**
 * History stores the canonical request path — percent-encoded and
 * trailing-slash-normalized exactly as `handle()` produced it — so a spy
 * filter must be put into the same form before it is compared, or the very
 * string the caller passed to `handle()` would not match its own record.
 * `canonicalizePath` is idempotent, so an already-encoded filter keeps
 * matching and both spellings work.
 */
function historyMatcher(
  method?: Schmock.HttpMethod,
  path?: string,
): (r: Schmock.RequestRecord) => boolean {
  const wanted =
    path === undefined ? undefined : normalizePath(canonicalizePath(path));
  return (r) =>
    (!method || r.method === method) && (!wanted || r.path === wanted);
}

/** What history records about the request, captured before any hook runs. */
export interface RequestHistorySnapshot {
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A matched request as it is committed to history. */
interface RequestHistoryEntry {
  /** The history generation the request was admitted under. */
  readonly generation: symbol;
  readonly method: Schmock.HttpMethod;
  /** The namespace-stripped, normalized path the route matched. */
  readonly path: string;
  readonly params: Record<string, string>;
  readonly snapshot: RequestHistorySnapshot;
  readonly response: Schmock.Response;
}

/**
 * The mock's request log and its spy API.
 *
 * Every read returns deep copies, so a caller can never corrupt the records.
 * A request is recorded only under the history generation it was admitted
 * with: `startGeneration()` ends the current one, so a request still in
 * flight when history is reset cannot write into the new log.
 */
export class RequestHistory {
  #records: Schmock.RequestRecord[] = [];
  #generation = Symbol("schmock.history.generation");
  readonly #limit: number | undefined;

  /**
   * @param limit `maxHistorySize`: FIFO bound on the number of records,
   *   `0` disables history, `undefined` keeps every record.
   * @throws SchmockError `INVALID_CONFIG` when the limit is not a
   *   non-negative integer.
   */
  constructor(limit: number | undefined) {
    assertValidHistoryLimit(limit);
    this.#limit = limit;
  }

  /** The token an admitted request captures and records under. */
  get generation(): symbol {
    return this.#generation;
  }

  /**
   * Copy what the CLIENT sent, before any plugin or the generator gets the
   * live objects and can edit them. `undefined` when history is disabled.
   */
  snapshotRequest(
    request: RequestHistorySnapshot,
  ): RequestHistorySnapshot | undefined {
    if (this.#limit === 0) return undefined;
    return {
      query: { ...request.query },
      headers: { ...request.headers },
      body: snapshotHistoryValue(request.body),
    };
  }

  /** Record a matched request, unless its history generation has ended. */
  record(entry: RequestHistoryEntry): void {
    if (entry.generation !== this.#generation || this.#limit === 0) return;

    const limit = this.#limit;
    this.#records.push({
      method: entry.method,
      path: entry.path,
      params: { ...entry.params },
      query: entry.snapshot.query,
      headers: entry.snapshot.headers,
      body: entry.snapshot.body,
      timestamp: Date.now(),
      response: {
        status: entry.response.status,
        body: snapshotNormalizedBody(entry.response.body),
      },
    });
    // The constructor already rejected a limit that is not a non-negative
    // integer, so a plain comparison is enough here.
    if (limit !== undefined && this.#records.length > limit) {
      this.#records.splice(0, this.#records.length - limit);
    }
  }

  /**
   * Start a new generation: a request admitted before it can no longer
   * record. The records themselves stay until `clear()`.
   */
  startGeneration(): void {
    this.#generation = Symbol("schmock.history.generation");
  }

  /** Drop every record. */
  clear(): void {
    this.#records = [];
  }

  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[] {
    if (method || path) {
      return this.#records
        .filter(historyMatcher(method, path))
        .map((r) => cloneRecord(r));
    }
    return this.#records.map((r) => cloneRecord(r));
  }

  called(method?: Schmock.HttpMethod, path?: string): boolean {
    if (method || path) {
      return this.#records.some(historyMatcher(method, path));
    }
    return this.#records.length > 0;
  }

  callCount(method?: Schmock.HttpMethod, path?: string): number {
    if (method || path) {
      return this.#records.filter(historyMatcher(method, path)).length;
    }
    return this.#records.length;
  }

  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined {
    if (method || path) {
      const filtered = this.#records.filter(historyMatcher(method, path));
      const last = filtered[filtered.length - 1];
      // FIX 2.3: return a deep clone so callers cannot corrupt internal history
      return last ? cloneRecord(last) : undefined;
    }
    const last = this.#records[this.#records.length - 1];
    // FIX 2.3: return a deep clone so callers cannot corrupt internal history
    return last ? cloneRecord(last) : undefined;
  }
}
