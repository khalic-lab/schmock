function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A v4 UUID for correlating one request's debug log lines. Total: it never
 * throws, because a diagnostic must not fail the request it describes.
 *
 * `crypto.randomUUID()` exists only in secure contexts, so a page served over
 * plain http (a LAN address, a docker hostname, `ng serve --host`) falls back
 * to `getRandomValues`, which is not gated, and a runtime without Web Crypto to
 * `Math.random`: a log correlation id needs no cryptographic strength.
 */
export function createRequestId(): string {
  const bytes = new Uint8Array(16);
  try {
    const webCrypto: Partial<Crypto> | undefined = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === "function") {
      return webCrypto.randomUUID();
    }
    if (typeof webCrypto?.getRandomValues === "function") {
      webCrypto.getRandomValues(bytes);
      return formatUuid(bytes);
    }
  } catch {
    // An unusable Web Crypto falls back like a missing one.
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return formatUuid(bytes);
}

/**
 * Debug logger that respects debug mode configuration
 */
export class DebugLogger {
  constructor(private enabled = false) {}

  log(category: string, message: string, data?: unknown) {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [SCHMOCK:${category.toUpperCase()}]`;

    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  time(label: string) {
    if (!this.enabled) return;
    console.time(`[SCHMOCK] ${label}`);
  }

  timeEnd(label: string) {
    if (!this.enabled) return;
    console.timeEnd(`[SCHMOCK] ${label}`);
  }
}
