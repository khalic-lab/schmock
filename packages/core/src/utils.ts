/**
 * Safe JSON stringify that handles circular references.
 */
export function safeStringify(obj: any): string {
  const cache = new Set();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (cache.has(value)) {
        return "[Circular]";
      }
      cache.add(value);
    }
    return value;
  });
}
