import type * as Schmock from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type { CrudOperation, CrudResource } from "./crud-detector.js";
import {
  arrayPropertyPath,
  collectSchemaProperties,
  findArrayProperty,
  listArrayHints,
} from "./list-envelope.js";
import { withoutExampleValues } from "./normalizer.js";
import { isRecord, toJsonSchema } from "./utils.js";

/*
 * Where a CRUD response carries its resource: as the item itself, in the slot
 * of an envelope, or as the entries of a list. The generators shape a stored
 * row into a response by it, and the bodies generated for a resource leave
 * its id without the values its examples would give it.
 */

/** What these rules read of a resource. */
type ResourceShape = Pick<CrudResource, "idProperty" | "idParam" | "schema">;

/** Whether `schema` declares `property` at its top level (`allOf` included). */
export function declaresTopLevel(
  schema: JSONSchema7,
  property: string,
): boolean {
  return Object.hasOwn(collectSchemaProperties(schema), property);
}

/**
 * When the create response is an envelope (`{ data: <Resource> }`) rather than
 * the resource itself, find the property that carries the resource, so the
 * stored item stays resource-shaped and only the *response* is wrapped.
 *
 * The response is "item-shaped" — no wrapper — when it declares the resource's
 * own id property at its top level. Otherwise the wrapper is the property whose
 * schema declares that id property. Returns `{}` (item-shaped) when no such
 * property exists, so a spec whose envelope this can't identify is left at the
 * historical behaviour rather than mis-wrapped.
 */
function findResourceWrapper(
  schema: JSONSchema7 | undefined,
  idProperty: string,
): { property?: string } {
  if (!schema || typeof schema === "boolean") return {};
  const top = collectSchemaProperties(schema);
  if (idProperty in top) return {};
  for (const [key, value] of Object.entries(top)) {
    if (idProperty in collectSchemaProperties(value)) return { property: key };
  }
  return {};
}

/**
 * The envelope property an operation's response wraps the resource in, if any.
 *
 * Only trusted when a resolved item schema exists to store and declares the id
 * property at its own top level. Without one (incomplete specs) the response
 * schema is treated as the item, so nothing that worked before is re-shaped.
 * When the item schema does not declare the id, the id is the path
 * parameter's fallback: a response without it at the top is then the plain
 * item, and a nested object that declares an `id` of its own (`team: { id }`
 * on a `User { userId }`) is a field of that item, not an envelope slot.
 */
export function resourceWrapperProperty(
  resource: ResourceShape,
  responseSchema: JSONSchema7 | undefined,
): string | undefined {
  const item = resource.schema;
  if (!item || !responseSchema || responseSchema === item) return undefined;
  if (!declaresTopLevel(item, resource.idProperty)) return undefined;
  return findResourceWrapper(responseSchema, resource.idProperty).property;
}

/**
 * Whether two contracts declare the same, non-empty set of top-level property
 * names: how a list route's GET is recognized as the item its POST creates.
 */
function sameTopLevelProperties(
  a: JSONSchema7 | undefined,
  b: JSONSchema7 | undefined,
): boolean {
  if (!a || !b) return false;
  const left = Object.keys(collectSchemaProperties(a));
  const right = new Set(Object.keys(collectSchemaProperties(b)));
  return (
    left.length > 0 &&
    left.length === right.size &&
    left.every((name) => right.has(name))
  );
}

/**
 * Whether a list route serves the resource's one item rather than a list.
 *
 * GET and POST on one path with no item route: a singleton read through the
 * list generator, or a list+create collection with no item routes. The GET
 * contract is the item only when the POST answers with that same shape (the
 * same top-level property names, as Stripe's Dispute GET and POST share one
 * schema). Only then is a top-level id read as "this is the item", so a real
 * collection's envelope that also carries an `id` (a request id) keeps
 * serving its rows.
 */
export function listServesItem(
  resource: Pick<CrudResource, "operations" | "routes">,
  listMeta: Schmock.CrudOperationMeta | undefined,
): boolean {
  return (
    !resource.operations.some(
      (op) => op === "read" || op === "update" || op === "delete",
    ) &&
    sameTopLevelProperties(
      listMeta?.responseSchema,
      resource.routes.find((route) => route.op === "create")?.meta
        .responseSchema,
    )
  );
}

type NodeMap = (node: Record<string, unknown>) => Record<string, unknown>;

/**
 * `node` with `map` applied to every declaration of the property at `path`,
 * level by level through `properties` and the branches of `allOf`, `anyOf`
 * and `oneOf` (the nullable wrapper included). Only the nodes along the path
 * are copied; with nothing to change, `node` itself comes back.
 */
function mapDeclarations(
  node: Record<string, unknown>,
  path: readonly string[],
  map: NodeMap,
  seen: Set<object> = new Set(),
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return map(node);
  if (seen.has(node)) return node;
  seen.add(node);

  let copy: Record<string, unknown> | undefined;
  const properties = node.properties;
  if (isRecord(properties) && Object.hasOwn(properties, head)) {
    const child = properties[head];
    const next = isRecord(child) ? mapDeclarations(child, rest, map) : child;
    if (next !== child) {
      // Entries, not assignment: a spec may name a property `__proto__`.
      copy = {
        ...node,
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [
            key,
            key === head ? next : value,
          ]),
        ),
      };
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const next = branches.map((branch: unknown) =>
      isRecord(branch) ? mapDeclarations(branch, path, map, seen) : branch,
    );
    if (next.some((branch, index) => branch !== branches[index])) {
      copy ??= { ...node };
      copy[keyword] = next;
    }
  }
  return copy ?? node;
}

/**
 * `node` with `map` applied to the items of every array it declares: its own
 * `items` (each entry of a tuple), and those of its `allOf`, `anyOf` and
 * `oneOf` branches.
 */
function mapItems(
  node: Record<string, unknown>,
  map: NodeMap,
  seen: Set<object> = new Set(),
): Record<string, unknown> {
  if (seen.has(node)) return node;
  seen.add(node);

  let copy: Record<string, unknown> | undefined;
  const items = node.items;
  if (isRecord(items)) {
    const next = map(items);
    if (next !== items) copy = { ...node, items: next };
  } else if (Array.isArray(items)) {
    const next = items.map((item: unknown) =>
      isRecord(item) ? map(item) : item,
    );
    if (next.some((item, index) => item !== items[index])) {
      copy = { ...node, items: next };
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const next = branches.map((branch: unknown) =>
      isRecord(branch) ? mapItems(branch, map, seen) : branch,
    );
    if (next.some((branch, index) => branch !== branches[index])) {
      copy ??= { ...node };
      copy[keyword] = next;
    }
  }
  return copy ?? node;
}

/**
 * The route metadata key holding a CRUD route's {@link IdExampleFilter}, for
 * the bodies `Prefer` generates outside the route's generator.
 */
export const ID_EXAMPLES_KEY = "openapi:idExamples";

/** The {@link IdExampleFilter} a CRUD route carries, if `route` is one. */
export function routeIdExamples(
  route: Schmock.RouteConfig,
): IdExampleFilter | undefined {
  const value: unknown = route[ID_EXAMPLES_KEY];
  return value instanceof IdExampleFilter ? value : undefined;
}

/** How a CRUD operation's response carries its resource. */
type Placement = "item" | "list";

function placementOf(op: CrudOperation): Placement {
  return op === "list" ? "list" : "item";
}

/**
 * Takes a CRUD resource's id out of what its `example` and `examples` give
 * it, in the body schemas generated for one of the resource's routes. A
 * stored row's id is minted (crud-ids.ts); in a generated body the id is
 * generated as on a node that declares no examples, so a list does not
 * repeat one sample in every entry, or a few from a small pool. A `default`
 * the spec declares on the id is kept.
 *
 * The id is found where the operation's response carries the resource: at
 * the top of an item, in the slot of an envelope, in each entry of a list
 * (and at the top of a list route's object contract that holds no list).
 *
 * A class so that route metadata, typed `unknown`, can be narrowed back to it
 * with `instanceof` (see request-pipeline.ts).
 */
export class IdExampleFilter {
  readonly #resource: ResourceShape;
  readonly #placement: Placement;
  readonly #servesItem: boolean;
  /** Filtered schemas by input: the route's declared schemas, or a hook's. */
  readonly #memo = new WeakMap<object, JSONSchema7>();

  /**
   * `servesItem` is {@link listServesItem} for a list route: its contract is
   * then read as the item whenever it declares the id at its top level.
   */
  constructor(resource: ResourceShape, op: CrudOperation, servesItem = false) {
    this.#resource = resource;
    this.#placement = placementOf(op);
    this.#servesItem = servesItem;
  }

  /** `schema`, or a copy of it whose resource id generates as unexampled. */
  apply(schema: JSONSchema7): JSONSchema7 {
    if (!isRecord(schema)) return schema;
    const cached = this.#memo.get(schema);
    if (cached) return cached;
    const filtered =
      this.#placement === "list" &&
      !(this.#servesItem && declaresTopLevel(schema, this.#resource.idProperty))
        ? this.#inList(schema)
        : this.#inItem(schema);
    const result = filtered === schema ? schema : toJsonSchema(filtered);
    this.#memo.set(schema, result);
    return result;
  }

  #inItem(
    schema: JSONSchema7 & Record<string, unknown>,
  ): Record<string, unknown> {
    const id = this.#resource.idProperty;
    const slot = declaresTopLevel(schema, id)
      ? undefined
      : resourceWrapperProperty(this.#resource, schema);
    // Without a slot the id is looked for at the top, in the branches of a
    // polymorphic item too.
    return mapDeclarations(
      schema,
      slot === undefined ? [id] : [slot, id],
      withoutExampleValues,
    );
  }

  #inList(
    schema: JSONSchema7 & Record<string, unknown>,
  ): Record<string, unknown> {
    const id = this.#resource.idProperty;
    const inEntry: NodeMap = (entry) =>
      mapDeclarations(entry, [id], withoutExampleValues);
    const info = findArrayProperty(schema, listArrayHints(this.#resource));
    const path = arrayPropertyPath(info);
    if (path) {
      return mapDeclarations(schema, path, (array) => mapItems(array, inEntry));
    }
    if (info.itemSchema) return mapItems(schema, inEntry);
    return this.#inItem(schema);
  }
}
