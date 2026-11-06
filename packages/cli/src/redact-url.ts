import { isCredentialName } from "@schmock/core/adapter";

const REDACTED = "[redacted]";

function decodedName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
}

function redactQuery(search: string): string {
  return search
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const name = separator === -1 ? pair : pair.slice(0, separator);
      return isCredentialName(decodedName(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join("&");
}

/**
 * A spec location as the startup banner prints it. For a URL, the password in
 * its userinfo and every query parameter named like a credential (core's
 * `isCredentialName`, the rule its debug log masks query parameters by) read
 * "[redacted]"; the rest keeps its exact spelling. A local path is returned
 * as given.
 */
export function redactSpecForDisplay(spec: string): string {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(spec);
  if (!scheme) return spec;
  const authorityStart = scheme[0].length;
  const rest = spec.slice(authorityStart);
  const authorityLength = rest.search(/[/?#]/);
  const authority =
    authorityLength === -1 ? rest : rest.slice(0, authorityLength);
  let tail = authorityLength === -1 ? "" : rest.slice(authorityLength);

  let displayAuthority = authority;
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon !== -1) {
      displayAuthority = `${userinfo.slice(0, colon)}:${REDACTED}${authority.slice(at)}`;
    }
  }

  const queryStart = tail.indexOf("?");
  if (queryStart !== -1) {
    const hashStart = tail.indexOf("#", queryStart);
    const queryEnd = hashStart === -1 ? tail.length : hashStart;
    tail = `${tail.slice(0, queryStart + 1)}${redactQuery(tail.slice(queryStart + 1, queryEnd))}${tail.slice(queryEnd)}`;
  }
  return `${scheme[0]}${displayAuthority}${tail}`;
}
