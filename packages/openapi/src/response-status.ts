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

export function findSuccessResponse<T>(
  responses: Map<ResponseStatusKey, T>,
): [status: number, entry: T] | undefined {
  for (const preferred of [200, 201]) {
    const entry = responses.get(preferred);
    if (entry !== undefined) return [preferred, entry];
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
