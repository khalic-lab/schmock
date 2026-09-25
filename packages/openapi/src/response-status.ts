export type ResponseStatusKey =
  | number
  | "default"
  | "1XX"
  | "2XX"
  | "3XX"
  | "4XX"
  | "5XX";

export function parseResponseStatusKey(
  value: string,
): ResponseStatusKey | undefined {
  if (value.toLowerCase() === "default") return "default";

  const range = value.toUpperCase();
  switch (range) {
    case "1XX":
    case "2XX":
    case "3XX":
    case "4XX":
    case "5XX":
      return range;
  }

  if (!/^\d{3}$/.test(value)) return undefined;
  return Number(value);
}

export function isStatusInRange(
  key: ResponseStatusKey,
  minimum: number,
  maximum: number,
): boolean {
  if (typeof key === "number") return key >= minimum && key < maximum;
  if (key === "default") return false;
  const rangeStart = Number(key[0]) * 100;
  return rangeStart >= minimum && rangeStart < maximum;
}

export function findResponseEntry<T>(
  responses: Map<ResponseStatusKey, T>,
  status: number,
): T | undefined {
  const exact = responses.get(status);
  if (exact !== undefined) return exact;

  let range: ResponseStatusKey | undefined;
  switch (Math.floor(status / 100)) {
    case 1:
      range = "1XX";
      break;
    case 2:
      range = "2XX";
      break;
    case 3:
      range = "3XX";
      break;
    case 4:
      range = "4XX";
      break;
    case 5:
      range = "5XX";
      break;
  }
  return (range ? responses.get(range) : undefined) ?? responses.get("default");
}

/** The order a plain operation picks its success status from. */
const DEFAULT_SUCCESS_STATUS_ORDER: readonly number[] = [200, 201];

/**
 * The order a CRUD create picks its success status from. A POST declaring both
 * `201 created` and `200 already exists` (an upsert contract) answers a fresh
 * create with 201, not 200.
 */
export const CREATE_SUCCESS_STATUS_ORDER: readonly number[] = [201, 200];

/**
 * The success status and entry an operation answers with.
 *
 * `preferred` lists the exact statuses tried first, in order; after them comes
 * the first other declared 2xx, then `2XX`, then `default` (both as 200).
 */
export function findSuccessResponse<T>(
  responses: Map<ResponseStatusKey, T>,
  preferred: readonly number[] = DEFAULT_SUCCESS_STATUS_ORDER,
): [status: number, entry: T] | undefined {
  for (const status of preferred) {
    const entry = responses.get(status);
    if (entry !== undefined) return [status, entry];
  }

  for (const [key, entry] of responses) {
    if (typeof key === "number" && key >= 200 && key < 300) {
      return [key, entry];
    }
  }

  const range = responses.get("2XX");
  if (range !== undefined) return [200, range];

  const fallback = responses.get("default");
  if (fallback !== undefined) return [200, fallback];

  return undefined;
}

/**
 * The status a mock answers an operation with.
 *
 * The spec-declared success status when one exists, otherwise the lowest
 * declared status — so an operation declaring only `404` and `503` answers
 * `404` from the `404` schema rather than inventing an undeclared `200 {}`.
 *
 * The minimum is taken in a single pass over *effective* numeric values, so a
 * range key beats a higher numeric one: `{"4XX", 503}` resolves to 400, not 503.
 */
export function findRepresentativeResponse<T>(
  responses: Map<ResponseStatusKey, T>,
): [status: number, entry: T] | undefined {
  const success = findSuccessResponse(responses);
  if (success) return success;

  let lowest: [status: number, entry: T] | undefined;
  for (const [key, entry] of responses) {
    // "default" is already consumed by findSuccessResponse; reaching here means
    // the map has none.
    if (key === "default") continue;
    const status = typeof key === "number" ? key : Number(key[0]) * 100;
    if (!lowest || status < lowest[0]) lowest = [status, entry];
  }
  return lowest;
}
