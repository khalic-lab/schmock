import type * as Schmock from "@schmock/core";
import { isRecord } from "./utils.js";

/**
 * Policy governing `$ref`s that leave the root document: `OpenApiOptions.refs`.
 *
 * An alias, not a copy, so a field added to `Schmock.OpenApiRefPolicy` reaches
 * {@link resolveRefPolicy} typed. External resolution is OFF by default: a
 * spec is untrusted input on the CLI, and `$ref` is a file-read/network
 * primitive.
 */
export type RefPolicy = Schmock.OpenApiRefPolicy;

interface ResolvedRefPolicy {
  external: boolean;
  allowHttp: boolean;
  allowedHosts: string[];
  timeoutMs: number;
  redirects: number;
  maxBytes: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_REDIRECTS = 0;
const DEFAULT_MAX_BYTES = 1_000_000;

export function resolveRefPolicy(policy?: RefPolicy): ResolvedRefPolicy {
  return {
    external: policy?.external === true,
    allowHttp: policy?.allowHttp === true,
    // `URL.hostname` is always ASCII-lowercased, so an allow-list entry with
    // uppercase letters would never match and would silently block a host the
    // operator explicitly allowed. Normalize entries to compare like with like.
    allowedHosts: (policy?.allowedHosts ?? []).map((host) =>
      host.toLowerCase(),
    ),
    timeoutMs: policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    redirects: policy?.redirects ?? DEFAULT_REDIRECTS,
    maxBytes: policy?.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The four octets of a dotted IPv4 literal, or `undefined`. */
function ipv4Octets(host: string): number[] | undefined {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return undefined;
  return [match[1], match[2], match[3], match[4]].map(Number);
}

/**
 * IPv4 space a spec must not reach: everything that is not ordinary public
 * unicast. The list follows the IANA special-purpose registry rather than
 * RFC1918 alone, because the addresses that matter in practice sit outside it:
 * `100.100.100.200` is Alibaba Cloud's metadata service, 100.64/10 is where a
 * Tailscale tailnet lives, and 198.18/15 is used for internal benchmarking
 * networks.
 */
function isBlockedIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a >= 224; // multicast 224/4, reserved 240/4, broadcast
}

/**
 * The eight 16-bit groups of an IPv6 literal, or `undefined` when `host` is not
 * one. Handles `::` compression and a dotted IPv4 tail (`::ffff:127.0.0.1`):
 * WHATWG `URL` normalizes a bracketed literal to hex before this runs, but an
 * address from a resolver or a hand-built ref can arrive in either spelling.
 */
function ipv6Groups(host: string): number[] | undefined {
  if (!host.includes(":")) return undefined;
  let text = host;
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = ipv4Octets(dotted[2]);
    if (!octets || octets.some((octet) => octet > 255)) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? gap : 0).fill("0"),
    ...tail,
  ];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address carried in two IPv6 groups, as four octets. */
function embeddedIpv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * IPv6 space a spec must not reach. Transition forms that CARRY an IPv4
 * address are classified by that address rather than blocked wholesale: NAT64
 * (64:ff9b::/96) is how an IPv6-only host reaches every public IPv4 server, so
 * refusing the whole prefix would cut such hosts off entirely.
 */
function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeroUpTo = (count: number): boolean =>
    groups.slice(0, count).every((group) => group === 0);

  if (zeroUpTo(5) && g5 === 0xffff) return isBlockedIpv4(embeddedIpv4(g6, g7)); // ::ffff:0:0/96 mapped
  if (zeroUpTo(4) && g4 === 0xffff && g5 === 0)
    return isBlockedIpv4(embeddedIpv4(g6, g7)); // ::ffff:0:0:0/96 translated
  if (zeroUpTo(6)) return true; // ::, ::1 and the deprecated IPv4-compatible ::/96
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isBlockedIpv4(embeddedIpv4(g6, g7)); // NAT64 well-known prefix
    }
    return g2 === 1; // 64:ff9b:1::/48 local-use NAT64
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, documentation
  if (g0 === 0x2002) return isBlockedIpv4(embeddedIpv4(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return (g0 & 0xff00) === 0xff00; // ff00::/8 multicast
}

/**
 * Hosts a spec must never be able to make the process talk to.
 *
 * Implemented here rather than delegated to ref-parser's `safeUrlResolver`:
 * supplying our own `canRead` replaces the built-in http resolver's checks
 * entirely, so the block has to be re-applied on this side.
 *
 * This rules on the NAME it is given, which is only a pre-filter for a DNS
 * name: `127.0.0.1.nip.io` looks public here. The Node transport
 * (`ref-transport.ts`) applies the same function to every address a name
 * resolves to, at connect time, which is where the block actually holds.
 */
export function isUnsafeHost(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A zone id (`fe80::1%en0`) selects an interface; the address is the same.
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  // A trailing dot is a fully-qualified-name terminator: `localhost.` and
  // `localhost` name the same host, so it must be stripped before the name
  // comparisons below, not only inside the IPv4 branch.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const groups = ipv6Groups(host);
  if (groups) return isBlockedIpv6(groups);
  // A name never contains a colon, so this is an IPv6 literal the parser
  // could not read. Refuse it rather than guess where it routes.
  if (host.includes(":")) return true;

  const octets = ipv4Octets(host);
  if (!octets) return false;
  if (octets.some((octet) => octet > 255)) return true;
  return isBlockedIpv4(octets);
}

export type RefVerdict = { allowed: true } | { allowed: false; reason: string };

/** An absolute `http:`/`https:` URL, in any case. */
export function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * Decide whether a single `$ref` may be resolved under `policy`.
 *
 * Used twice on purpose: once as a pre-scan over the root document (so a
 * blocked ref is reported as policy, never as a network or filesystem error,
 * and never after a request has gone out) and once inside the http resolver's
 * `canRead` (so refs reached through a nested document are checked too).
 */
export function checkRef(ref: string, policy: ResolvedRefPolicy): RefVerdict {
  if (ref.startsWith("#")) return { allowed: true };

  if (!policy.external) {
    return {
      allowed: false,
      reason: "external reference resolution is disabled",
    };
  }

  if (!isHttpUrl(ref)) return { allowed: true };

  if (!policy.allowHttp) {
    return {
      allowed: false,
      reason: "http(s) reference resolution is disabled",
    };
  }

  let hostname: string;
  try {
    hostname = new URL(ref).hostname;
  } catch {
    return { allowed: false, reason: "reference URL could not be parsed" };
  }

  if (
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.includes(hostname)
  ) {
    return { allowed: false, reason: `host "${hostname}" is not allowed` };
  }

  if (isUnsafeHost(hostname)) {
    return {
      allowed: false,
      reason: `host "${hostname}" is loopback, link-local or private`,
    };
  }

  return { allowed: true };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The network half of an http `$ref` read, shaped like `fetch`.
 *
 * `readHttpRef` owns the policy — redirects, size, deadline — and this owns
 * the connection. The Node resolver supplies `ref-transport.ts`, which resolves
 * the host itself, refuses when any address is unsafe and connects to the
 * address it vetted; a plain `fetch` cannot do that, because it rules on
 * nothing and resolves the name again on its own. Implementations must not
 * follow redirects: every hop comes back here to be re-checked.
 */
export type RefFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Response>;

/**
 * Plain `fetch`, looked up at call time so a test's spy is honoured. Only a
 * direct caller of {@link buildRefParserOptions} gets it: `parseSpec` always
 * passes the resolver's own transport.
 */
const plainFetch: RefFetch = (url, init) =>
  fetch(url, { redirect: "manual", signal: init.signal });

interface HttpRefRead {
  url: string;
  policy: ResolvedRefPolicy;
  fetchRef: RefFetch;
  diagnostics?: Map<string, string>;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  );
}

/**
 * An error's message plus whatever its `cause` adds: undici reports every
 * network failure as `fetch failed`, with the actual `ENOTFOUND` /
 * `ECONNREFUSED` / certificate problem only on the cause.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const detail =
    cause instanceof Error
      ? cause.message
      : isRecord(cause) && typeof cause.code === "string"
        ? cause.code
        : undefined;
  return detail !== undefined && !error.message.includes(detail)
    ? `${error.message} (${detail})`
    : error.message;
}

/** Release a response whose body will not be read, so its socket is freed. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Read a body as UTF-8, or `undefined` as soon as it passes `maxBytes`.
 *
 * Counted per chunk while streaming, and after any content decoding the
 * transport did: measuring a fully buffered `response.text()` bounds nothing,
 * since a chunked body or a small gzip stream can fill the heap first.
 */
async function readTextWithin(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Every failure this resolver raises, recorded under the url it happened on.
 *
 * ref-parser wraps a resolver throw in `{ plugin, error }` — an object with no
 * `message` — and its `ResolverError` constructor then falls back to
 * `Error reading file "<url>"`, so the size/timeout/status detail is destroyed
 * before any caller can see it. Handing the message out of band is the only way
 * to get it back without taking a direct dependency on ref-parser's error class.
 * Deliberately NOT part of {@link RefParserOptions}: naming a ref-parser type in
 * the published surface is what the option shape exists to avoid.
 */
async function readHttpRef({
  url,
  policy,
  fetchRef,
  diagnostics,
}: HttpRefRead): Promise<string> {
  // Keyed on the ORIGINAL url, which is the one ref-parser reports as the
  // failing source — a redirect target would never be looked up.
  const fail = (message: string, cause?: unknown): Error => {
    diagnostics?.set(url, message);
    return cause === undefined
      ? new Error(message)
      : new Error(message, { cause });
  };

  // One deadline for the whole redirect chain, not per hop, so a redirector
  // cannot stretch the budget by bouncing the request around.
  const signal = AbortSignal.timeout(policy.timeoutMs);

  // A rejected request or body read: the deadline, or the network. Both used
  // to escape as ref-parser's bare `Error reading file`.
  const unreachable = (at: string, error: unknown): Error =>
    signal.aborted && isTimeoutReason(signal.reason)
      ? fail(
          `external $ref ${url} timed out after ${policy.timeoutMs}ms`,
          error,
        )
      : fail(
          `external $ref ${at} could not be fetched: ${describeError(error)}`,
          error,
        );

  let currentUrl = url;

  // Redirects are followed manually so every hop's destination is re-checked
  // against the policy. `fetch(..., { redirect: "follow" })` would resolve the
  // whole chain internally and only `canRead` the first URL, letting an
  // allow-listed host bounce the request to a loopback/RFC1918 address.
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await fetchRef(currentUrl, { signal });
    } catch (error) {
      throw unreachable(currentUrl, error);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      const location = response.headers.get("location");
      if (!location) {
        throw fail(
          `external $ref ${currentUrl} returned ${response.status} with no Location header`,
        );
      }
      if (hops >= policy.redirects) {
        throw fail(
          `external $ref ${url} exceeded the redirect limit of ${policy.redirects}`,
        );
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        throw fail(
          `external $ref ${currentUrl} redirected to an unparseable location`,
        );
      }
      // Before `checkRef`, which allows every non-http ref once `external` is
      // on: a `Location: file:///…` must never reach a transport that reads it.
      if (!isHttpUrl(next)) {
        throw fail(
          `external $ref redirect to ${next} blocked: only http(s) redirect targets are followed`,
        );
      }
      const verdict = checkRef(next, policy);
      if (!verdict.allowed) {
        throw fail(
          `external $ref redirect to ${next} blocked: ${verdict.reason}`,
        );
      }
      currentUrl = next;
      continue;
    }

    if (!response.ok) {
      await discardBody(response);
      throw fail(
        `external $ref ${currentUrl} responded with ${response.status} ${response.statusText}`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
      await discardBody(response);
      throw fail(
        `external $ref ${currentUrl} declares ${declaredLength} bytes, above the ${policy.maxBytes} byte limit`,
      );
    }

    let text: string | undefined;
    try {
      text = await readTextWithin(response, policy.maxBytes);
    } catch (error) {
      throw unreachable(currentUrl, error);
    }
    if (text === undefined) {
      throw fail(
        `external $ref ${currentUrl} returned more than ${policy.maxBytes} bytes, above the ${policy.maxBytes} byte limit`,
      );
    }
    return text;
  }
}

/**
 * The exact swagger-parser options shape this module produces.
 *
 * Structural on purpose: naming the library's own `SwaggerParser.Options` in
 * an exported signature would pull `@apidevtools/json-schema-ref-parser`'s
 * Node-typed declarations into the published `.d.ts`, which breaks consumers
 * compiling without `@types/node`. Assignability to the real options type is
 * checked where `parseSpec` hands it to swagger-parser.
 */
export interface RefParserOptions {
  resolve: {
    external: boolean;
    http?:
      | false
      | {
          timeout: number;
          redirects: number;
          canRead: (file: { url: string }) => boolean;
          read: (file: { url: string }) => Promise<string>;
        };
  };
  timeoutMs?: number;
}

/**
 * Translate a {@link RefPolicy} into swagger-parser resolve options.
 *
 * Every branch maps 1:1 onto a ref-parser option; there is no extra layer.
 * `fetchRef` is the transport http `$ref`s are read through; `parseSpec`
 * passes the resolver's guarded one, see {@link RefFetch}.
 */
export function buildRefParserOptions(
  policy?: RefPolicy,
  diagnostics?: Map<string, string>,
  fetchRef: RefFetch = plainFetch,
): RefParserOptions {
  const resolved = resolveRefPolicy(policy);

  if (!resolved.external) {
    return { resolve: { external: false } };
  }

  if (!resolved.allowHttp) {
    return { resolve: { external: true, http: false } };
  }

  return {
    resolve: {
      external: true,
      http: {
        timeout: resolved.timeoutMs,
        redirects: resolved.redirects,
        // The http resolver must claim http(s) URLs only: `checkRef` passes a
        // plain file path when `external` is on, and claiming it here would
        // hand a filesystem path to `fetch`.
        canRead: (file: { url: string }) =>
          isHttpUrl(file.url) && checkRef(file.url, resolved).allowed,
        read: (file: { url: string }) =>
          readHttpRef({
            url: file.url,
            policy: resolved,
            fetchRef,
            diagnostics,
          }),
      },
    },
    timeoutMs: resolved.timeoutMs * 4,
  };
}

/**
 * Collect every `$ref` in `root` that does not point back into the document.
 *
 * Run over a raw document these are the refs a policy has to rule on; run over
 * a dereferenced one they are the refs resolution silently left behind
 * (`resolve.external: false` does not error, it just leaves the `$ref` object
 * in the tree, from where it would flow into AJV and the faker generator).
 *
 * The `WeakSet` is not an optimisation: a dereferenced document shares object
 * identity across every use of a component and is routinely circular, so the
 * walk does not terminate without it.
 */
export function collectUnresolvedRefs(root: unknown): string[] {
  const seen = new WeakSet<object>();
  const found = new Set<string>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }

    if (isRecord(node)) {
      const ref = node.$ref;
      if (typeof ref === "string" && !ref.startsWith("#")) {
        found.add(ref);
      }
      for (const child of Object.values(node)) stack.push(child);
    }
  }

  return [...found];
}
