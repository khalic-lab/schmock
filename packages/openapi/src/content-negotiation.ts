import { normalizeMediaType } from "./utils.js";

/**
 * One parsed `Accept` range: the media range plus its quality value.
 * `q=0` entries are kept — they are exclusions, not noise.
 */
interface AcceptRange {
  type: string;
  q: number;
}

/**
 * How precisely `range` describes `mediaType`.
 *
 * 3 exact, 2 `type/*`, 1 `*\/*`, 0 no match — RFC 9110's precedence order.
 * This is what stops a broad range from overriding a narrower one: an entry is
 * scored by its MOST specific matching range, so `*\/*;q=1, application/json;q=0`
 * excludes JSON instead of re-admitting it through the wildcard.
 *
 * Both sides are compared parameter-free. `parseAcceptRanges` already strips the
 * Accept side, and a spec's `content` key may legally carry parameters — the OAS
 * 3.0 Response Object example itself uses `text/plain; charset=utf-8`. Comparing
 * that raw key made every exact-type Accept score 0, so the route answered 406
 * even to the exact string the 406 body advertised as acceptable. Only the
 * comparison is normalized: `negotiateContentType` still returns the RAW
 * `available` entry, because `ParsedResponseEntry.content` and the CRUD
 * `responseSchemasByMediaType` map are both keyed with the unmodified spec key.
 */
function specificity(range: string, mediaType: string): number {
  const candidate = normalizeMediaType(mediaType);
  if (range === candidate) return 3;
  if (range === "*/*") return 1;
  if (range.endsWith("/*")) {
    // Same prefix test the exact-match-free path has always used: "application/*"
    // keeps its trailing slash so it cannot match "application-x/plain".
    return candidate.startsWith(range.slice(0, -1)) ? 2 : 0;
  }
  return 0;
}

function parseAcceptRanges(accept: string): AcceptRange[] {
  return accept.split(",").map((part) => {
    const [type, ...params] = part.trim().split(";");
    let q = 1;
    for (const param of params) {
      const match = param.trim().match(/^q\s*=\s*([\d.]+)$/);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
      }
    }
    return { type: type.trim().toLowerCase(), q };
  });
}

/**
 * Negotiate the best content type match for an Accept header.
 * Supports quality values (q=0.8) and wildcards (*\/*).
 * Returns the matched content type or null if no match.
 *
 * Scoring is per REPRESENTATION, not per Accept entry: each available media type
 * takes the q of the most specific range that matches it, and the best positive
 * score wins. Ties keep the server's `available` order authoritative, so client
 * preference never reorders what the spec declares first.
 */
export function negotiateContentType(
  accept: string,
  available: string[],
): string | null {
  if (!accept || accept === "*/*") {
    return available[0] ?? null;
  }

  const ranges = parseAcceptRanges(accept);

  let best: string | null = null;
  let bestScore = 0;

  for (const contentType of available) {
    let matched = 0;
    let q = 0;
    for (const range of ranges) {
      const level = specificity(range.type, contentType);
      // Strictly greater: within one specificity level the first occurrence wins.
      if (level > matched) {
        matched = level;
        q = range.q;
      }
    }
    if (matched === 0 || q === 0) continue;
    if (q > bestScore) {
      bestScore = q;
      best = contentType;
    }
  }

  return best;
}
