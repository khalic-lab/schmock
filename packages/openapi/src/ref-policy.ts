import { isRecord } from "./utils.js";

/**
 * Policy governing `$ref`s that leave the root document.
 *
 * Mirrors `Schmock.OpenApiRefPolicy`. External resolution is OFF by default:
 * a spec is untrusted input on the CLI, and `$ref` is a file-read/network
 * primitive.
 */
export interface RefPolicy {
  /** Allow any `$ref` that leaves the root document. Default `false`. */
  external?: boolean;
  /** Allow `http(s)` `$ref`s. Requires `external`. Default `false`. */
  allowHttp?: boolean;
  /**
   * Hostnames an `http(s)` `$ref` may target. Empty or omitted means "any
   * host", still minus the unsafe-host block (loopback, link-local, RFC1918).
   */
  allowedHosts?: string[];
  /** Per-request timeout for http `$ref`s, in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Redirects to follow for an http `$ref`. Default 0.
   *
   * `fetch` has no numeric redirect cap, so this is effectively a boolean:
   * `0` refuses redirects outright, any positive value follows up to the
   * platform default. Rely on `allowedHosts` for precision.
   */
  redirects?: number;
  /** Maximum size of a single http `$ref` document, in bytes. Default 1 MB. */
  maxBytes?: number;
}

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

/**
 * Hosts a spec must never be able to make the process talk to.
 *
 * Implemented here rather than delegated to ref-parser's `safeUrlResolver`:
 * supplying our own `canRead` replaces the built-in http resolver's checks
 * entirely, so the block has to be re-applied on this side.
 */
/**
 * Extract the embedded IPv4 address of an IPv4-mapped IPv6 literal, in either
 * spelling. WHATWG `URL` rewrites the dotted form `::ffff:169.254.169.254`
 * into the hex form `::ffff:a9fe:a9fe` before this code ever sees it, but a ref
 * can also reach `checkRef` unnormalized, so both are handled. Returns the
 * dotted IPv4 string so the IPv4 blocks can rule on it, or `undefined`.
 */
function mappedIpv4(host: string): string | undefined {
  const rest = /^::ffff:(.+)$/.exec(host)?.[1];
  if (rest === undefined) return undefined;
  if (IPV4_PATTERN.test(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return undefined;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isUnsafeHost(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A trailing dot is a fully-qualified-name terminator: `localhost.` and
  // `localhost` name the same host, so it must be stripped before the name
  // comparisons below, not only inside the IPv4 branch.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1")
    return true;
  // fe80::/10 link-local and fc00::/7 unique-local IPv6
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  // An IPv4-mapped IPv6 literal routes to its embedded IPv4 address, so the
  // loopback/RFC1918/link-local blocks have to see through the mapping.
  host = mappedIpv4(host) ?? host;

  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((value) => !Number.isInteger(value) || value > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 0 || a === 127) return true; // this-host, loopback
  if (a === 10) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

export type RefVerdict = { allowed: true } | { allowed: false; reason: string };

function isHttpUrl(ref: string): boolean {
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
async function readHttpRef(
  url: string,
  policy: ResolvedRefPolicy,
  diagnostics?: Map<string, string>,
): Promise<string> {
  // Keyed on the ORIGINAL url, which is the one ref-parser reports as the
  // failing source — a redirect target would never be looked up.
  const fail = (message: string): Error => {
    diagnostics?.set(url, message);
    return new Error(message);
  };

  // One deadline for the whole redirect chain, not per hop, so a redirector
  // cannot stretch the budget by bouncing the request around.
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let currentUrl = url;

  // Redirects are followed manually so every hop's destination is re-checked
  // against the policy. `fetch(..., { redirect: "follow" })` would resolve the
  // whole chain internally and only `canRead` the first URL, letting an
  // allow-listed host bounce the request to a loopback/RFC1918 address.
  for (let hops = 0; ; hops++) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
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
      throw fail(
        `external $ref ${currentUrl} responded with ${response.status} ${response.statusText}`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
      throw fail(
        `external $ref ${currentUrl} declares ${declaredLength} bytes, above the ${policy.maxBytes} byte limit`,
      );
    }

    const text = await response.text();
    const actualLength = new TextEncoder().encode(text).length;
    if (actualLength > policy.maxBytes) {
      throw fail(
        `external $ref ${currentUrl} returned ${actualLength} bytes, above the ${policy.maxBytes} byte limit`,
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
 */
export function buildRefParserOptions(
  policy?: RefPolicy,
  diagnostics?: Map<string, string>,
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
          readHttpRef(file.url, resolved, diagnostics),
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
