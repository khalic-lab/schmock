import type { ServerResponse } from "node:http";
import { isBinaryBody } from "./binary.js";

interface RequestWithHeaders {
  readonly headers: {
    readonly [header: string]: string | string[] | undefined;
  };
}

interface BodyReadable {
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end", listener: () => void): this;
  destroy(error?: Error): this;
}

/**
 * Convert Node.js IncomingMessage headers to a flat Record<string, string>.
 * Drops array-valued headers (keeps only string values).
 */
export function parseNodeHeaders(
  req: RequestWithHeaders,
): Record<string, string> {
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
  req: BodyReadable,
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

  const hasContentType = Object.keys(responseHeaders).some(
    (header) => header.toLowerCase() === "content-type",
  );

  if (
    !hasContentType &&
    response.body !== undefined &&
    isBinaryBody(response.body)
  ) {
    responseHeaders["content-type"] = "application/octet-stream";
  } else if (
    !hasContentType &&
    response.body !== undefined &&
    typeof response.body !== "string"
  ) {
    responseHeaders["content-type"] = "application/json";
  }

  let responseBody: string | Uint8Array | undefined;
  if (response.body === undefined) {
    responseBody = undefined;
  } else if (typeof response.body === "string") {
    responseBody = response.body;
  } else if (response.body instanceof ArrayBuffer) {
    responseBody = new Uint8Array(response.body);
  } else if (ArrayBuffer.isView(response.body)) {
    responseBody = new Uint8Array(
      response.body.buffer,
      response.body.byteOffset,
      response.body.byteLength,
    );
  } else {
    responseBody = JSON.stringify(response.body);
  }

  res.writeHead(response.status, responseHeaders);
  res.end(responseBody);
}
