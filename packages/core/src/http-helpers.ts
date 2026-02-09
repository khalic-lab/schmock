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

/**
 * Collect and parse the request body from a Node.js IncomingMessage.
 * Returns parsed JSON if content-type includes "json", otherwise the raw string.
 * Returns undefined for empty bodies.
 */
export function collectBody(
  req: IncomingMessage,
  headers: Record<string, string>,
): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
