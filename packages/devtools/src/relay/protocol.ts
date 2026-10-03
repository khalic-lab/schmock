import { version } from "../../package.json";
import type {
  AbortRequestMessage,
  PageToWorkerMessage,
  ReadyMessage,
  RelayReply,
  ReleasedMessage,
  RequestMessage,
  SerializedRequest,
  SerializedResponse,
} from "./types.js";

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_VERSION: string = version;
export const DEFAULT_WORKER_URL = "/schmock-sw.js";
export const RELAY_REGISTRY_CACHE = `schmock-relay-v${RELAY_PROTOCOL_VERSION}`;
export const REGISTRY_KEY_PATH = "__schmock-relay/clients";
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

// ── guards ───────────────────────────────────────────────────────────

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const type = Reflect.get(value, "type");
  return typeof type === "string" ? type : undefined;
}

function isHeaderPairs(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function isBody(value: unknown): value is ArrayBuffer | null {
  return value === null || value instanceof ArrayBuffer;
}

function isSerializedRequest(value: unknown): value is SerializedRequest {
  return (
    isObject(value) &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "method") === "string" &&
    isHeaderPairs(Reflect.get(value, "headers")) &&
    isBody(Reflect.get(value, "body"))
  );
}

function isSerializedResponse(value: unknown): value is SerializedResponse {
  return (
    isObject(value) &&
    typeof Reflect.get(value, "status") === "number" &&
    typeof Reflect.get(value, "statusText") === "string" &&
    isHeaderPairs(Reflect.get(value, "headers")) &&
    isBody(Reflect.get(value, "body"))
  );
}

export function isPageToWorkerMessage(
  value: unknown,
): value is PageToWorkerMessage {
  const type = typeOf(value);
  if (type === "schmock:goodbye" || type === "schmock:claim") return true;
  return (
    type === "schmock:hello" &&
    isObject(value) &&
    typeof Reflect.get(value, "protocol") === "number" &&
    typeof Reflect.get(value, "version") === "string"
  );
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    typeOf(value) === "schmock:ready" &&
    isObject(value) &&
    typeof Reflect.get(value, "protocol") === "number" &&
    typeof Reflect.get(value, "version") === "string"
  );
}

export function isReleasedMessage(value: unknown): value is ReleasedMessage {
  return typeOf(value) === "schmock:released";
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  return (
    typeOf(value) === "schmock:request" &&
    isObject(value) &&
    isSerializedRequest(Reflect.get(value, "request"))
  );
}

export function isRelayReply(value: unknown): value is RelayReply {
  const type = typeOf(value);
  if (type === "schmock:passthrough" || type === "schmock:aborted") return true;
  if (!isObject(value)) return false;
  if (type === "schmock:response") {
    return isSerializedResponse(Reflect.get(value, "response"));
  }
  if (type === "schmock:error") {
    const error = Reflect.get(value, "error");
    return (
      isObject(error) &&
      typeof Reflect.get(error, "name") === "string" &&
      typeof Reflect.get(error, "message") === "string"
    );
  }
  return false;
}

export function isAbortRequestMessage(
  value: unknown,
): value is AbortRequestMessage {
  return typeOf(value) === "schmock:abort";
}

// ── serialization ────────────────────────────────────────────────────

export async function serializeRequest(
  request: Request,
): Promise<SerializedRequest> {
  const bodiless =
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null;
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    body: bodiless ? null : await request.arrayBuffer(),
  };
}

export function deserializeRequest(
  serialized: SerializedRequest,
  signal: AbortSignal,
): Request {
  return new Request(serialized.url, {
    method: serialized.method,
    headers: serialized.headers,
    body: serialized.body,
    signal,
  });
}

export async function serializeResponse(
  response: Response,
): Promise<SerializedResponse> {
  let body: ArrayBuffer | null = null;
  if (response.body !== null) {
    const buffer = await response.arrayBuffer();
    body = buffer.byteLength === 0 ? null : buffer;
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body,
  };
}

export function deserializeResponse(serialized: SerializedResponse): Response {
  return new Response(
    NULL_BODY_STATUSES.has(serialized.status) ? null : serialized.body,
    {
      status: serialized.status,
      statusText: serialized.statusText,
      headers: serialized.headers,
    },
  );
}

export function transferablesOf(
  serialized: SerializedRequest | SerializedResponse,
): ArrayBuffer[] {
  return serialized.body === null ? [] : [serialized.body];
}

// ── ask ──────────────────────────────────────────────────────────────

interface AskOptions {
  readonly transfer?: Transferable[];
  /** Forward an abort to the other side, keep waiting. */
  readonly abortSignal?: AbortSignal;
  /** Give up: resolve undefined. */
  readonly timeoutMs?: number;
  /** Give up now: resolve undefined. */
  readonly cancelSignal?: AbortSignal;
}

export function ask<M>(
  target: { postMessage(message: M, transfer: Transferable[]): void },
  message: M,
  options: AskOptions = {},
): Promise<unknown> {
  const { transfer, abortSignal, timeoutMs, cancelSignal } = options;
  if (cancelSignal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const port = channel.port1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sendAbort = () => {
      port.postMessage({ type: "schmock:abort" });
    };
    const finish = (value: unknown) => {
      abortSignal?.removeEventListener("abort", sendAbort);
      cancelSignal?.removeEventListener("abort", onCancel);
      if (timer !== undefined) clearTimeout(timer);
      port.onmessage = null;
      port.close();
      resolve(value);
    };
    const onCancel = () => finish(undefined);
    port.onmessage = (event) => finish(event.data);
    try {
      target.postMessage(message, [channel.port2, ...(transfer ?? [])]);
    } catch (error) {
      port.onmessage = null;
      port.close();
      reject(error);
      return;
    }
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) sendAbort();
      else abortSignal.addEventListener("abort", sendAbort, { once: true });
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(undefined), timeoutMs);
    }
    cancelSignal?.addEventListener("abort", onCancel, { once: true });
  });
}
