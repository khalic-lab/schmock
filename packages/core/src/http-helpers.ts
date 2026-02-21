import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Convert Node.js IncomingMessage headers to a flat Record<string, string>.
 * Drops array-valued headers (keeps only string values).
 */
export function parseNodeHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Extract query parameters from a URL as a flat Record<string, string>.
 */
export function parseNodeQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

/** Default body size limit: 10 MB */
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Collect and parse the request body from a Node.js IncomingMessage.
 * Returns parsed JSON if content-type includes "json", otherwise the raw string.
 * Returns undefined for empty bodies.
 * @param req - Node.js IncomingMessage
 * @param headers - Parsed request headers
 * @param maxBodySize - Maximum body size in bytes (default: 10 MB)
 */
export function collectBody(
  req: IncomingMessage,
  headers: Record<string, string>,
  maxBodySize = DEFAULT_MAX_BODY_SIZE,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("error", reject);

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBodySize) {
        req.destroy();
        reject(
          Object.assign(new Error("Request body too large"), { status: 413 }),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve(undefined);
        return;
      }
      const contentType = headers["content-type"] ?? "";
      if (contentType.includes("json")) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      } else {
        resolve(raw);
      }
    });
  });
}

/**
 * Write a Schmock Response to a Node.js ServerResponse.
 * Serializes non-string bodies as JSON and sets content-type when missing.
 */
export function writeSchmockResponse(
  res: ServerResponse,
  response: Schmock.Response,
  extraHeaders?: Record<string, string>,
): void {
  const responseHeaders: Record<string, string> = {
    ...response.headers,
    ...extraHeaders,
  };

  if (
    !responseHeaders["content-type"] &&
    response.body !== undefined &&
    typeof response.body !== "string"
  ) {
    responseHeaders["content-type"] = "application/json";
  }

  const responseBody =
    response.body === undefined
      ? undefined
      : typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);

  res.writeHead(response.status, responseHeaders);
  res.end(responseBody);
}
