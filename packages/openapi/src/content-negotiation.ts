/**
 * Negotiate the best content type match for an Accept header.
 * Supports quality values (q=0.8) and wildcards (*\/*).
 * Returns the matched content type or null if no match.
 */
export function negotiateContentType(
  accept: string,
  available: string[],
): string | null {
  if (!accept || accept === "*/*") {
    return available[0] ?? null;
  }

  // Parse Accept header into sorted entries by quality
  const entries = accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      let q = 1;
      for (const param of params) {
        const match = param.trim().match(/^q\s*=\s*([\d.]+)$/);
        if (match) {
          q = Number.parseFloat(match[1]);
        }
      }
      return { type: type.trim(), q };
    })
    .sort((a, b) => b.q - a.q);

  for (const entry of entries) {
    if (entry.q === 0) continue;

    // Wildcard matches anything
    if (entry.type === "*/*") {
      return available[0] ?? null;
    }

    // Type wildcard (e.g., "application/*")
    if (entry.type.endsWith("/*")) {
      const prefix = entry.type.slice(0, -1);
      const match = available.find((ct) => ct.startsWith(prefix));
      if (match) return match;
      continue;
    }

    // Exact match
    if (available.includes(entry.type)) {
      return entry.type;
    }
  }

  return null;
}
