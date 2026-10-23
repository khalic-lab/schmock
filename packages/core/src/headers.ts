/**
 * Header names whose value is a credential, in lowercase. Debug logs replace
 * their values with "[redacted]" (see {@link redactHeaders}) and keep the name,
 * so a log still shows the header was sent. The CLI's admin history masks the
 * same set.
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-schmock-admin-token",
]);

const REDACTED_HEADER_VALUE = "[redacted]";

/**
 * A name of the shape credentials take: exactly `key`, `token`, `apikey`,
 * `api_key`, `api-key`, `secret` or `password`, or any name ending in one of
 * those after a `-` or `_` (`X-Pet-Key`, `access_token`, `client_secret`). It
 * catches the conventional spellings of an API key scheme's parameter; a name
 * outside the pattern (`X-Pet-Credential`) does not match.
 */
const CREDENTIAL_NAME = /(?:^|[-_])(?:api[-_]?key|key|token|secret|password)$/;

/**
 * Whether a header or query parameter name looks like a credential (see
 * {@link CREDENTIAL_NAME}), compared case-insensitively. The debug log masks
 * query parameters by this rule, and the CLI's admin history masks headers and
 * query parameters by it.
 */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase());
}

/**
 * Replace the value of every query parameter named like a credential with
 * "[redacted]". Copy-on-write, like {@link redactHeaders}.
 */
export function redactQuery(
  query: Record<string, string>,
): Record<string, string> {
  let redacted: Record<string, string> | undefined;
  for (const name of Object.keys(query)) {
    if (!isCredentialName(name)) continue;
    redacted ??= { ...query };
    redacted[name] = REDACTED_HEADER_VALUE;
  }
  return redacted ?? query;
}

/**
 * Look a header up by name, ignoring case. Response headers keep the casing a
 * route gave them, so `headers["content-type"]` can miss a `Content-Type`.
 * @returns the first matching value, or `undefined`
 */
export function getHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/**
 * Whether a header of that name is present, ignoring case, whatever its value.
 * Unlike `getHeader(...) !== undefined`, a key present with a non-string value
 * counts, so the response normalizer still gets to reject that value.
 */
export function hasHeader(
  headers: Readonly<Record<string, unknown>>,
  name: string,
): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Replace the value of every {@link SENSITIVE_HEADER_NAMES} header with
 * "[redacted]", matching names case-insensitively.
 *
 * Copy-on-write: the input is never mutated, and when nothing is sensitive the
 * same object is returned.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  let redacted: Record<string, string> | undefined;
  for (const name of Object.keys(headers)) {
    if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) continue;
    redacted ??= { ...headers };
    redacted[name] = REDACTED_HEADER_VALUE;
  }
  return redacted ?? headers;
}
