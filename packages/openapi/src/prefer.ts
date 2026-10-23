import { parameterValue, splitOutsideQuotes } from "./content-negotiation.js";

interface PreferDirectives {
  code?: number;
  example?: string;
  dynamic?: boolean;
}

/**
 * The statuses a `code=N` directive may name: the range core serves. A `1XX`
 * status or one outside 100-599 cannot be a final response, and an operation
 * declaring `default` matched every such number, so `code=999` answered 200
 * with the `[999, body]` tuple serialized as the body.
 */
const MIN_PREFER_STATUS = 200;
const MAX_PREFER_STATUS = 599;

/**
 * Parse the RFC 7240 Prefer header for mock-specific directives.
 * Supports: code=N, example=name, dynamic[=true]
 *
 * Follows the RFC grammar rather than one exact spelling: preferences are
 * comma-separated, each may carry `;`-parameters (ignored here), the token name
 * is case-insensitive, whitespace may surround `=`, and the value may be a
 * quoted-string. Delimiters inside a quoted value are not syntax. The example
 * NAME keeps its case, because it is looked up as a key in the spec. A `code`
 * outside 200-599 is ignored like an unknown directive.
 */
export function parsePreferHeader(value: string): PreferDirectives {
  const result: PreferDirectives = {};

  for (const preference of splitOutsideQuotes(value, ",")) {
    const [head] = splitOutsideQuotes(preference, ";");
    const equals = head.indexOf("=");
    const name = (equals < 0 ? head : head.slice(0, equals))
      .trim()
      .toLowerCase();
    const rawValue =
      equals < 0 ? undefined : parameterValue(head.slice(equals + 1));

    if (name === "code") {
      const code =
        rawValue !== undefined && /^\d+$/.test(rawValue)
          ? Number(rawValue)
          : undefined;
      if (
        code !== undefined &&
        code >= MIN_PREFER_STATUS &&
        code <= MAX_PREFER_STATUS
      ) {
        result.code = code;
      }
    } else if (name === "example") {
      if (rawValue) result.example = rawValue;
    } else if (name === "dynamic") {
      if (rawValue === undefined || rawValue.toLowerCase() === "true") {
        result.dynamic = true;
      }
    }
  }

  return result;
}
