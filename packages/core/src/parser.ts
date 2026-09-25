import { canonicalizePath, normalizePath, toHttpMethod } from "./constants.js";
import { RouteParseError } from "./errors.js";
import type { HttpMethod } from "./types.js";

export interface ParsedRoute {
  method: HttpMethod;
  path: string;
  pattern: RegExp;
  params: string[];
}

/**
 * Parse 'METHOD /path' route key format
 *
 * Design note: We validate the format strictly to catch typos early.
 * The 'METHOD /path' format was chosen for its readability and
 * similarity to API documentation formats.
 *
 * @example
 * parseRouteKey('GET /users/:id')
 * // => { method: 'GET', path: '/users/:id', pattern: /^\/users\/([^/]+)$/, params: ['id'] }
 */
export function parseRouteKey(routeKey: string): ParsedRoute {
  // The path group must start with "/": every transport (server, interceptor,
  // adapters) delivers a leading-slash pathname, so a slash-less key such as
  // "GET users" compiles a route no request can ever reach. `.*` is kept
  // deliberately — hostile-but-reachable segments (spaces, tabs, unicode) must
  // still parse.
  const match = routeKey.match(
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) (\/.*)$/,
  );

  if (!match) {
    throw new RouteParseError(
      routeKey,
      'Expected format: "METHOD /path" (e.g., "GET /users")',
    );
  }

  const [, method, rawPath] = match;

  // Tokenize once, then derive `path`, `pattern` and `params` from the same
  // tokens. `path` is canonicalized here so the duplicate check, the
  // static-route Map key and getRoutes() all agree on one spelling: the
  // percent-encoded transport form with a single trailing slash stripped.
  const tokens = tokenizeRoutePath(routeKey, normalizePath(rawPath));
  const params = tokens.flatMap((token) =>
    token.kind === "param" ? [token.name] : [],
  );

  return {
    method: toHttpMethod(method),
    path: serializeRoutePath(tokens, params.length > 0),
    pattern: new RegExp(`^${compileRoutePattern(tokens)}$`),
    params,
  };
}

/*
 * Route path grammar
 *
 * - `:name` is a parameter. A plain name is `[A-Za-z0-9_-]+`, so surrounding
 *   literals (".json", brackets, parens, etc.) terminate it and are escaped
 *   rather than bleeding into the parameter regex.
 * - Hyphens that end a plain name directly before another parameter are the
 *   separator between the two: `:from-:to` is `from`, "-", `to`, as in Express.
 *   A hyphen inside a name (`:user-id`) still belongs to it.
 * - `:"name"` quotes a name outside the plain grammar (`:"user.id"`); the
 *   request's params are keyed by the text between the quotes.
 * - `\:` is a literal colon, so `:job\:cancel` is one parameter followed by the
 *   literal ":cancel" (Google AIP custom methods).
 * - Two parameters with nothing between them are rejected: no input decides
 *   where one ends.
 */
type RouteToken =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "param"; readonly name: string; readonly quoted: boolean };

interface ParamRead {
  name: string;
  quoted: boolean;
  /** Index just past the parameter. */
  end: number;
}

const PLAIN_NAME_CHAR = /^[A-Za-z0-9_-]$/;
const TRAILING_HYPHENS = /-+$/;
/** A bare colon that a later parse would read as the start of a parameter. */
const COLON_BEFORE_NAME = /:(?=[A-Za-z0-9_-])/g;

/**
 * Read the parameter whose ':' sits at `index`, or undefined when that colon
 * is a literal: nothing name-like follows it, or the quote is unclosed or
 * empty (both of which were literal text before quoted names existed).
 */
function readParam(path: string, index: number): ParamRead | undefined {
  if (path[index] !== ":") return undefined;
  if (path[index + 1] === '"') {
    const close = path.indexOf('"', index + 2);
    if (close <= index + 2) return undefined;
    return { name: path.slice(index + 2, close), quoted: true, end: close + 1 };
  }
  let end = index + 1;
  while (end < path.length && PLAIN_NAME_CHAR.test(path[end])) end += 1;
  if (end === index + 1) return undefined;
  return { name: path.slice(index + 1, end), quoted: false, end };
}

function tokenizeRoutePath(routeKey: string, path: string): RouteToken[] {
  const tokens: RouteToken[] = [];
  let literal = "";

  const pushParam = (name: string, quoted: boolean) => {
    if (literal) {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "param") {
      throw new RouteParseError(
        routeKey,
        `Parameters ":${previous.name}" and ":${name}" are adjacent, so nothing decides where one ends. Put a literal between them (e.g. ":${previous.name}-:${name}"), or write a literal colon as "\\:".`,
      );
    }
    tokens.push({ kind: "param", name, quoted });
  };

  let index = 0;
  while (index < path.length) {
    if (path[index] === "\\" && path[index + 1] === ":") {
      literal += ":";
      index += 2;
      continue;
    }

    const param = readParam(path, index);
    if (!param) {
      literal += path[index];
      index += 1;
      continue;
    }

    if (!param.quoted && readParam(path, param.end)) {
      const name = param.name.replace(TRAILING_HYPHENS, "");
      if (name) {
        pushParam(name, false);
      } else {
        // A name made only of hyphens leaves nothing to name: the colon is
        // literal text, as it would be without the parameter that follows.
        literal += ":";
      }
      literal += param.name.slice(name.length);
    } else {
      pushParam(param.name, param.quoted);
    }
    index = param.end;
  }

  if (literal) tokens.push({ kind: "literal", text: literal });
  return tokens;
}

/**
 * The route's canonical spelling: literals in the percent-encoded transport
 * form (see canonicalizePath) and parameters as written. A route with
 * parameters keeps a `\:` escape wherever a bare colon would start a
 * parameter. A route without parameters is spelled as its literal path,
 * because that string is also the static-route key a request is looked up by.
 */
function serializeRoutePath(
  tokens: readonly RouteToken[],
  hasParams: boolean,
): string {
  return tokens
    .map((token) => {
      if (token.kind === "param") {
        return token.quoted ? `:"${token.name}"` : `:${token.name}`;
      }
      const canonical = canonicalizePath(token.text);
      return hasParams
        ? canonical.replace(COLON_BEFORE_NAME, "\\:")
        : canonical;
    })
    .join("");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCharClass(char: string): string {
  return char.replace(/[\\\]^-]/g, "\\$&");
}

/**
 * Compile tokens to a regex source.
 *
 * A parameter that is the only one in its path segment, or the last one,
 * captures `[^/]+` exactly as it always has — so `:name.json` still matches
 * "report.v2.json" greedily. A parameter followed in the same segment by a
 * literal and then another parameter also excludes that literal's first
 * character, so it can only end at the separator:
 * `:year-:month-:day` → `([^/-]+)-([^/-]+)-([^/]+)`. Without the exclusion
 * every capture could end anywhere, and a long non-matching segment
 * backtracked quadratically (two parameters) or cubically (three).
 */
function compileRoutePattern(tokens: readonly RouteToken[]): string {
  return tokens
    .map((token, index) => {
      if (token.kind === "literal") {
        return escapeRegExp(canonicalizePath(token.text));
      }
      const next = tokens[index + 1];
      if (
        next?.kind === "literal" &&
        !next.text.includes("/") &&
        tokens[index + 2]?.kind === "param"
      ) {
        const separator = canonicalizePath(next.text)[0];
        return `([^/${escapeCharClass(separator)}]+)`;
      }
      return "([^/]+)";
    })
    .join("");
}
