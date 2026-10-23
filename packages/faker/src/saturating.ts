/** Keep node estimates finite and comparable on pathological schemas. */
export function capped(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}
