import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { SchmockError } from "@schmock/core";
import { isUnsafeHost, type RefFetch } from "./ref-policy.js";

/**
 * The http `$ref` transport of the Node build: the half of the SSRF block that
 * a hostname check cannot provide.
 *
 * `checkRef` rules on the name in the URL, so `127.0.0.1.nip.io`,
 * `localtest.me` or `my-laptop.local` sail through it and `fetch` then
 * resolves them to loopback or a private address. This transport resolves the
 * name itself, refuses when ANY address it gets back is unsafe, and hands the
 * vetted addresses to the socket through `lookup`, so the connection goes to
 * exactly what was checked. That also closes DNS rebinding: there is no second
 * resolution between the check and the connect for an attacker to answer
 * differently. Redirect hops come back through `readHttpRef`, which calls this
 * again, so every hop is vetted the same way.
 *
 * Only `resolver.ts` imports this module, so the browser build — which swaps in
 * `resolver.browser.ts` and refuses external refs outright — never contains
 * it. The `node:` modules are imported dynamically for the same reason
 * `seed-file.ts` does it: both builds use a browser target, and a static
 * `node:` import risks being replaced with a polyfill.
 */

/** One address a hostname resolved to, as `dns.lookup` reports it. */
interface ResolvedAddress {
  address: string;
  family: number;
}

export interface GuardedFetchOptions {
  /** Every address a hostname resolves to. Default: `dns.lookup`, `all: true`. */
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * Whether an address must not be connected to. Default {@link isUnsafeHost}.
   * Exists for tests, which can only listen on loopback; nothing that takes
   * user configuration reaches it.
   */
  isBlockedAddress?: (address: string) => boolean;
}

const REQUEST_HEADERS = {
  accept: "*/*",
  "accept-encoding": "gzip, deflate, br",
  "user-agent": "@schmock/openapi",
};

/** Statuses the Fetch standard forbids a body on; `new Response` throws otherwise. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const dns = await import("node:dns");
  return dns.promises.lookup(hostname, { all: true });
}

function blockedAddress(hostname: string, address: string): SchmockError {
  const subject =
    hostname === address
      ? `host "${hostname}" is`
      : `host "${hostname}" resolves to ${address}, which is`;
  return new SchmockError(
    `${subject} loopback, link-local or private`,
    "OPENAPI_EXTERNAL_REF_BLOCKED",
    { host: hostname, address },
  );
}

function requestedFamily(family: number | string | undefined): number {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

interface GuardedLookupContext {
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;
  isBlocked: (address: string) => boolean;
}

/**
 * A `lookup` for `http.request` that vets before it answers. Node calls it
 * with `all: true` when it races address families and without it otherwise,
 * and both shapes are honoured. Every address is vetted, not just the one the
 * socket will use: a name that resolves to one public and one private address
 * is refused outright rather than trusted to pick the public one.
 */
function guardedLookup({
  resolveHost,
  isBlocked,
}: GuardedLookupContext): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname).then(
      (addresses) => {
        const unsafe = addresses.find(({ address }) => isBlocked(address));
        if (unsafe !== undefined) {
          callback(blockedAddress(hostname, unsafe.address), []);
          return;
        }
        const family = requestedFamily(options.family);
        const usable = addresses.filter(
          (entry) => family === 0 || entry.family === family,
        );
        if (usable.length === 0) {
          callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
              code: "ENOTFOUND",
              hostname,
            }),
            [],
          );
          return;
        }
        if (options.all === true) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), []);
      },
    );
  };
}

/**
 * The body as the transport received it, decoded. `fetch` decodes
 * transparently and a hand-rolled request has to as well, both for servers
 * that ignore `accept-encoding` and so that `maxBytes` counts decoded bytes —
 * a 64 KB gzip body can decode to gigabytes.
 */
async function decodedBody(
  incoming: IncomingMessage,
  encoding: string | null,
): Promise<Readable> {
  const coding = (encoding ?? "").trim().toLowerCase();
  if (coding === "" || coding === "identity") return incoming;
  const [zlib, stream] = await Promise.all([
    import("node:zlib"),
    import("node:stream"),
  ]);
  const decoder =
    coding === "gzip" || coding === "x-gzip"
      ? zlib.createGunzip()
      : coding === "deflate"
        ? zlib.createInflate()
        : coding === "br"
          ? zlib.createBrotliDecompress()
          : undefined;
  if (decoder === undefined) {
    incoming.destroy();
    throw new Error(`unsupported content-encoding "${coding}"`);
  }
  return stream.pipeline(incoming, decoder, () => undefined);
}

/**
 * A pull-based web stream over a Node one: nothing is read from the socket
 * until the consumer asks, and cancelling destroys the source — decoder and
 * socket with it — which is how `readHttpRef` stops a body at `maxBytes`.
 */
function toWebStream(body: Readable): ReadableStream<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) {
        controller.close();
      } else if (value instanceof Uint8Array) {
        controller.enqueue(value);
      } else {
        controller.enqueue(new TextEncoder().encode(String(value)));
      }
    },
    cancel() {
      body.destroy();
    },
  });
}

async function toResponse(incoming: IncomingMessage): Promise<Response> {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const init = { status, statusText: incoming.statusMessage ?? "", headers };
  if (NULL_BODY_STATUSES.has(status)) {
    incoming.resume();
    return new Response(null, init);
  }
  const body = await decodedBody(incoming, headers.get("content-encoding"));
  return new Response(toWebStream(body), init);
}

/**
 * A {@link RefFetch} that only ever connects to addresses that passed the
 * unsafe-address block. One request per call, no redirects followed, no
 * pooled sockets: `agent: false` guarantees the socket is the one opened with
 * the guarded `lookup`, never one some other code left in the global pool.
 */
export function createGuardedFetch(
  options: GuardedFetchOptions = {},
): RefFetch {
  const resolveHost = options.resolveHost ?? systemResolve;
  const isBlocked = options.isBlockedAddress ?? isUnsafeHost;

  return async (url, { signal }) => {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`external $ref ${url} is not an http(s) URL`);
    }
    const [http, https, net] = await Promise.all([
      import("node:http"),
      import("node:https"),
      import("node:net"),
    ]);

    // A literal address never reaches `lookup`, so it is vetted here.
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) !== 0 && isBlocked(host)) {
      throw blockedAddress(host, host);
    }

    const client = target.protocol === "https:" ? https : http;
    const lookup = guardedLookup({ resolveHost, isBlocked });
    return new Promise<Response>((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: "GET",
          headers: REQUEST_HEADERS,
          agent: false,
          lookup,
          signal,
        },
        (incoming) => {
          toResponse(incoming).then(resolve, (error: unknown) => {
            incoming.destroy();
            reject(error);
          });
        },
      );
      request.once("error", reject);
      request.end();
    });
  };
}
