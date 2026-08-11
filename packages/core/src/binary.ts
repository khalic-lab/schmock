/**
 * Browser-safe binary body detection.
 *
 * Every ArrayBuffer view is accepted, including DataView, typed arrays backed
 * by SharedArrayBuffer, and Node.js Buffer without referencing its global.
 */
export function isBinaryBody(
  value: unknown,
): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}
