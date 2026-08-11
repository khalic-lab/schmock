/**
 * Scope-correct state keys for CRUD collections.
 *
 * Keys are derived from the resource's `basePath` (which keeps its parameters in
 * `:param` form, e.g. `/owners/:ownerId/pets`) plus the request's path params,
 * so two resources whose last path segment happens to match — `/users` and
 * `/admins/users` — never share one collection, and a nested collection gets one
 * collection per parent id.
 *
 * Resulting shapes:
 * - `openapi:collections:/pets`
 * - `openapi:collections:/admins/users`
 * - `openapi:collections:/owners/:ownerId/pets|ownerId=7`
 */

const COLLECTION_PREFIX = "openapi:collections:";
const COUNTER_PREFIX = "openapi:counter:";
const SEEDED_PREFIX = "openapi:seeded:";

/**
 * Parent path parameter names, in path order.
 * `"/owners/:ownerId/pets"` → `["ownerId"]`; `"/pets"` → `[]`.
 *
 * The resource's own id parameter never appears here: `basePath` is the
 * collection path, so the item id segment has already been stripped.
 */
export function parentParamNames(basePath: string): string[] {
  return basePath
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/**
 * Scope discriminator appended to a collection key.
 * `""` when the collection has no parent params, else `"|ownerId=7,teamId=3"`.
 *
 * Only the param *value* is percent-encoded: `basePath` and param names cannot
 * contain `|` or `,`, but a value can.
 */
export function scopeSuffix(
  basePath: string,
  params: Record<string, string>,
): string {
  const names = parentParamNames(basePath);
  if (names.length === 0) return "";
  const pairs = names.map(
    (name) => `${name}=${encodeURIComponent(params[name] ?? "")}`,
  );
  return `|${pairs.join(",")}`;
}

/** State key holding the collection array for this resource scope. */
export function collectionStateKey(
  basePath: string,
  params: Record<string, string>,
): string {
  return `${COLLECTION_PREFIX}${basePath}${scopeSuffix(basePath, params)}`;
}

/** State key holding the id counter for this resource scope. */
export function counterStateKey(
  basePath: string,
  params: Record<string, string>,
): string {
  return `${COUNTER_PREFIX}${basePath}${scopeSuffix(basePath, params)}`;
}

/** State key marking this resource scope as already seeded. */
export function seededStateKey(
  basePath: string,
  params: Record<string, string>,
): string {
  return `${SEEDED_PREFIX}${basePath}${scopeSuffix(basePath, params)}`;
}
