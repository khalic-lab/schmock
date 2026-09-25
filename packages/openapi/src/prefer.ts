import { parameterValue, splitOutsideQuotes } from "./content-negotiation.js";

interface PreferDirectives {
  code?: number;
  example?: string;
  dynamic?: boolean;
}

/**
 * Parse the RFC 7240 Prefer header for mock-specific directives.
 * Supports: code=N, example=name, dynamic[=true]
 *
 * Follows the RFC grammar rather than one exact spelling: preferences are
 * comma-separated, each may carry `;`-parameters (ignored here), the token name
 * is case-insensitive, whitespace may surround `=`, and the value may be a
 * quoted-string. Delimiters inside a quoted value are not syntax. The example
 * NAME keeps its case, because it is looked up as a key in the spec.
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
      if (rawValue !== undefined && /^\d+$/.test(rawValue)) {
        result.code = Number(rawValue);
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
