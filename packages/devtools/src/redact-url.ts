import { isCredentialName } from "@schmock/core/adapter";

const REDACTED = "[redacted]";

function decodedName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
}

/**
 * `url` with the value of every query parameter named like a credential
 * (core's `isCredentialName`, the rule its debug log masks query parameters
 * by) replaced with "[redacted]". The rest of the URL keeps its exact
 * spelling: re-serializing through `URLSearchParams` would re-encode every
 * other parameter.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const hashStart = url.indexOf("#", queryStart);
  const queryEnd = hashStart === -1 ? url.length : hashStart;
  let changed = false;
  const pairs = url
    .slice(queryStart + 1, queryEnd)
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const name = separator === -1 ? pair : pair.slice(0, separator);
      if (!isCredentialName(decodedName(name))) return pair;
      changed = true;
      return `${name}=${REDACTED}`;
    });
  if (!changed) return url;
  return `${url.slice(0, queryStart + 1)}${pairs.join("&")}${url.slice(queryEnd)}`;
}
