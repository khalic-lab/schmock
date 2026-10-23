/**
 * How every transport reads a request body: which shape a media type decodes
 * to, and how a JSON body is parsed. `collectBody()` (the Node ingress behind
 * `mock.listen()` and the CLI) and the fetch interceptor both build on it, so
 * the same request reaches a handler as the same value either way.
 */

export type HttpIngressErrorCode =
  | "MALFORMED_JSON"
  | "JSON_TOO_DEEP"
  | "MALFORMED_MULTIPART"
  | "PAYLOAD_TOO_LARGE";

/** An HTTP client error raised while collecting an incoming request body. */
export class HttpIngressError extends Error {
  constructor(
    public readonly status: 400 | 413,
    public readonly code: HttpIngressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpIngressError";
  }
}

/**
 * Deepest JSON nesting a request body may carry. A body nested far deeper
 * parses fine but cannot be serialized back (JSON.stringify overflows the
 * stack), so a handler that stores it poisons every later response that
 * includes it. Rejecting it at ingress keeps that from ever happening.
 */
const MAX_JSON_BODY_DEPTH = 256;

/**
 * The value a request body decodes to, by media type:
 *
 * - `json` (`application/json` and `+json`): the parsed value
 * - `form` (`application/x-www-form-urlencoded`): a flat object, last
 *   duplicate wins
 * - `text` (`text/*`): a UTF-8 string
 * - `multipart` (`multipart/*`): `FormData`
 * - `binary` (anything else, including no content type): an `ArrayBuffer`
 */
export type RequestBodyKind = "json" | "form" | "text" | "multipart" | "binary";

/** The media type of a content-type value, lowercased, without parameters. */
function baseMediaTypeOf(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** How a body with this content type decodes; see {@link RequestBodyKind}. */
export function requestBodyKindOf(
  contentType: string | null | undefined,
): RequestBodyKind {
  const mediaType = baseMediaTypeOf(contentType ?? "");
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  if (mediaType.startsWith("text/")) return "text";
  if (mediaType.startsWith("multipart/")) return "multipart";
  return "binary";
}

/** Whether a parsed JSON value nests deeper than `maxDepth` containers. */
function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value !== "object" || next.value === null) continue;
    const depth = next.depth + 1;
    if (depth > maxDepth) return true;
    for (const child of Object.values(next.value)) {
      pending.push({ value: child, depth });
    }
  }
  return false;
}

/**
 * Parse a JSON request body.
 *
 * @throws HttpIngressError `MALFORMED_JSON` when the text does not parse, and
 *   `JSON_TOO_DEEP` when it nests deeper than 256 levels.
 */
export function parseJsonBody(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpIngressError(
      400,
      "MALFORMED_JSON",
      "Malformed JSON request body",
    );
  }
  if (exceedsJsonDepth(parsed, MAX_JSON_BODY_DEPTH)) {
    throw new HttpIngressError(
      400,
      "JSON_TOO_DEEP",
      `JSON request body nests deeper than ${MAX_JSON_BODY_DEPTH} levels`,
    );
  }
  return parsed;
}

/** A flat object of urlencoded form fields; a repeated key keeps its last value. */
export function parseFormBody(text: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(text));
}
