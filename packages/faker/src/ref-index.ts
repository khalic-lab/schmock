import { SchemaValidationError } from "@schmock/core";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { collectSchemaChildren } from "./schema-children.js";
import { isJSONSchema7 } from "./utils.js";

/**
 * Resolves the local references `validateSchema` follows: JSON Pointers,
 * embedded `$id` resources and anchors, each from the scope of the schema
 * that holds the reference.
 */
export interface LocalRefResolver {
  /** The schema a reference names, from the scope of the schema holding it. */
  resolve(
    schema: JSONSchema7,
    reference: string,
  ): JSONSchema7Definition | undefined;
}

const INTERNAL_ROOT_ID = "schmock://local/root.json";

interface SchemaScope {
  baseUri: string;
  resourceRoot: JSONSchema7;
}

interface ReferenceIndex {
  resources: Map<string, JSONSchema7Definition>;
  scopes: Map<JSONSchema7, SchemaScope>;
  rootScope: SchemaScope;
}

interface IndexFrame {
  schema: JSONSchema7;
  inheritedScope: SchemaScope;
  path: string;
}

/**
 * Index every `$id`, `$anchor` and `$dynamicAnchor` under `root`, rejecting
 * duplicate canonical identifiers, and return a resolver over that index.
 */
export function createLocalRefResolver(root: JSONSchema7): LocalRefResolver {
  const index = createReferenceIndex(root);
  const cache = new Map<
    JSONSchema7,
    Map<string, JSONSchema7Definition | null>
  >();
  const scopeOf = (schema: JSONSchema7): SchemaScope =>
    index.scopes.get(schema) ?? index.rootScope;

  return {
    resolve(schema, reference) {
      let schemaCache = cache.get(schema);
      if (!schemaCache) {
        schemaCache = new Map();
        cache.set(schema, schemaCache);
      }
      const cached = schemaCache.get(reference);
      if (cached !== undefined) return cached === null ? undefined : cached;

      const resolved = resolveIndexedReference(
        reference,
        scopeOf(schema),
        index.resources,
      );
      schemaCache.set(reference, resolved ?? null);
      return resolved;
    },
  };
}

function createReferenceIndex(root: JSONSchema7): ReferenceIndex {
  const resources = new Map<string, JSONSchema7Definition>();
  const scopes = new Map<JSONSchema7, SchemaScope>();
  const rootScope: SchemaScope = {
    baseUri: INTERNAL_ROOT_ID,
    resourceRoot: root,
  };
  resources.set(INTERNAL_ROOT_ID, root);

  const pending: IndexFrame[] = [
    { schema: root, inheritedScope: rootScope, path: "$" },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame || scopes.has(frame.schema)) continue;

    const scope = indexSchemaIdentifiers(
      frame.schema,
      frame.inheritedScope,
      resources,
      frame.path,
    );
    scopes.set(frame.schema, scope);
    for (const edge of collectSchemaChildren(frame.schema, frame.path)) {
      pending.push({
        schema: edge.schema,
        inheritedScope: scope,
        path: edge.path,
      });
    }
  }

  return {
    resources,
    scopes,
    rootScope: scopes.get(root) ?? rootScope,
  };
}

function indexSchemaIdentifiers(
  schema: JSONSchema7,
  inheritedScope: SchemaScope,
  resources: ReferenceIndex["resources"],
  path: string,
): SchemaScope {
  let scope = inheritedScope;
  if (typeof schema.$id === "string") {
    const identifier = resolveUri(schema.$id, inheritedScope.baseUri);
    if (identifier) {
      registerIdentifier(resources, identifier, schema, path);
      if (uriFragment(identifier) === "") {
        const documentUri = withoutUriFragment(identifier);
        registerIdentifier(resources, documentUri, schema, path);
        scope = { baseUri: documentUri, resourceRoot: schema };
      } else {
        scope = { ...inheritedScope, baseUri: identifier };
      }
    }
  }

  for (const keyword of ["$anchor", "$dynamicAnchor"] as const) {
    const anchor = Reflect.get(schema, keyword);
    if (typeof anchor === "string" && anchor.length > 0) {
      const identifier = `${withoutUriFragment(scope.baseUri)}#${anchor}`;
      registerIdentifier(resources, identifier, schema, `${path}.${keyword}`);
    }
  }
  return scope;
}

function registerIdentifier(
  resources: Map<string, JSONSchema7Definition>,
  identifier: string,
  schema: JSONSchema7,
  path: string,
): void {
  const owner = resources.get(identifier);
  if (owner !== undefined && owner !== schema) {
    throw new SchemaValidationError(
      path,
      `Duplicate canonical schema identifier: "${identifier}"`,
      "Give each embedded resource and anchor a unique canonical identifier",
    );
  }
  resources.set(identifier, schema);
}

function resolveIndexedReference(
  reference: string,
  scope: SchemaScope,
  resources: Map<string, JSONSchema7Definition>,
): JSONSchema7Definition | undefined {
  if (reference === "#") return scope.resourceRoot;
  if (reference.startsWith("#/")) {
    return resolveJsonPointer(scope.resourceRoot, reference.slice(1));
  }

  const identifier = resolveUri(reference, scope.baseUri);
  if (!identifier) return undefined;
  const exact = resources.get(identifier);
  if (exact !== undefined) return exact;

  const resource = resources.get(withoutUriFragment(identifier));
  if (resource === undefined) return undefined;
  const fragment = uriFragment(identifier);
  if (fragment === "") return resource;
  return fragment.startsWith("/")
    ? resolveJsonPointer(resource, fragment)
    : undefined;
}

function resolveUri(reference: string, baseUri: string): string | undefined {
  try {
    return new URL(reference, baseUri).href;
  } catch {
    return undefined;
  }
}

function withoutUriFragment(identifier: string): string {
  const url = new URL(identifier);
  url.hash = "";
  return url.href;
}

function uriFragment(identifier: string): string {
  return new URL(identifier).hash.slice(1);
}

function resolveJsonPointer(
  root: JSONSchema7Definition,
  encodedPointer: string,
): JSONSchema7Definition | undefined {
  let pointer: string;
  try {
    pointer = decodeURIComponent(encodedPointer);
  } catch {
    return undefined;
  }
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;

  let current: unknown = root;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return typeof current === "boolean" || isJSONSchema7(current)
    ? current
    : undefined;
}
