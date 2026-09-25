import type * as Schmock from "@schmock/core";
import { isStatusTuple, SchmockError } from "@schmock/core";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { version as packageVersion } from "../package.json";

export interface ValidationRules {
  request?: {
    body?: JSONSchema7;
    /** Reject an absent body before the route generator executes. */
    bodyRequired?: boolean;
    query?: JSONSchema7;
    headers?: JSONSchema7;
  };
  response?: {
    body?: JSONSchema7;
    /**
     * Response statuses whose bodies `body` validates: `"2xx"` for 200-299, or
     * an explicit list of statuses. Omitted, every response is validated,
     * including error tuples and other plugins' request rejections.
     */
    statuses?: "2xx" | readonly number[];
  };
}

export interface ValidationPluginOptions extends ValidationRules {
  /** Custom status code for request validation failures (default: 400) */
  requestErrorStatus?: number;
  /** Custom status code for response validation failures (default: 500) */
  responseErrorStatus?: number;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Mirrors `isResponseObject` in `@schmock/core`'s response parser. The two
 * guards must agree exactly: whenever core refuses to unwrap an envelope it
 * delivers the whole object as the body, so a looser guard here would validate
 * a payload that never reaches the transport.
 */
function isStructuredResponse(
  value: unknown,
): value is { status: number; body: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value &&
    (!("headers" in value) ||
      value.headers === undefined ||
      isStringRecord(value.headers))
  );
}

function getResponseBody(response: unknown): unknown {
  if (isStatusTuple(response)) return response[1];
  if (isStructuredResponse(response)) return response.body;
  return response;
}

/**
 * Mirrors how core's response parser assigns a status: tuples and envelopes
 * carry their own, a bare `null`/`undefined` becomes 204 and any other bare
 * body 200.
 */
function getResponseStatus(response: unknown): number {
  if (isStatusTuple(response)) return response[0];
  if (isStructuredResponse(response)) return response.status;
  return response === null || response === undefined ? 204 : 200;
}

type StatusScope = "all" | "2xx" | ReadonlySet<number>;

function statusScopeError(received: unknown): SchmockError {
  return new SchmockError(
    'validationPlugin: response.statuses must be "2xx" or a non-empty array of integer statuses from 100 through 599',
    "VALIDATION_CONFIG_INVALID",
    { option: "response.statuses", received },
  );
}

function snapshotStatusScope(value: unknown): StatusScope {
  if (value === undefined) return "all";
  if (value === "2xx") return "2xx";
  if (!Array.isArray(value) || value.length === 0) {
    throw statusScopeError(value);
  }
  const statuses = new Set<number>();
  for (const status of value) {
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    ) {
      throw statusScopeError(value);
    }
    statuses.add(status);
  }
  return statuses;
}

function isStatusInScope(scope: StatusScope, status: number): boolean {
  if (scope === "all") return true;
  if (scope === "2xx") return status >= 200 && status <= 299;
  return scope.has(status);
}

interface AjvOptions {
  /**
   * Query and header values always arrive as strings, so their slots coerce
   * scalar types (`"2"` satisfies `type: "integer"`). Bodies keep strict types.
   */
  coerceTypes: boolean;
}

function createAjv({ coerceTypes }: AjvOptions = { coerceTypes: false }): Ajv {
  // `ownProperties` keeps validation aligned with the transport: JSON.stringify
  // emits own enumerable properties only, so inherited members must neither
  // satisfy `required` nor trip `additionalProperties`.
  const ajv = new Ajv({ allErrors: true, ownProperties: true, coerceTypes });
  // Schemas produced by @schmock/openapi carry schmock generation markers.
  // Draft-07 Ajv defaults to strictSchema:true and would throw
  // "strict mode: unknown keyword" at compile time on any of them.
  ajv.addVocabulary(["faker", "schmockNullable", "schmockTrueProbability"]);
  addFormats(ajv);
  return ajv;
}

type SchemaUriResolver = Ajv["opts"]["uriResolver"];

interface SchemaInventory {
  schema: JSONSchema7;
  resources: ReadonlyMap<string, JSONSchema7>;
  resourceParents: ReadonlyMap<string, string | undefined>;
}

interface PendingSchema {
  schema: JSONSchema7;
  baseId: string;
  resourceId: string | undefined;
}

const EMPTY_ID_FRAGMENT = /#\/?$/;

function normalizeSchemaId(
  resolver: SchemaUriResolver,
  baseId: string,
  id: string,
): string {
  const resolved = resolver.resolve(baseId, id.replace(EMPTY_ID_FRAGMENT, ""));
  const component = resolver.parse(resolved);
  return resolver
    .serialize({
      ...component,
      scheme: component.scheme?.toLowerCase(),
      host: component.host?.toLowerCase(),
    })
    .replace(EMPTY_ID_FRAGMENT, "");
}

function pushDefinition(
  children: JSONSchema7[],
  definition: JSONSchema7Definition | undefined,
): void {
  if (
    typeof definition === "object" &&
    definition !== null &&
    !Array.isArray(definition)
  ) {
    children.push(definition);
  }
}

function pushDefinitionMap(
  children: JSONSchema7[],
  definitions: Record<string, JSONSchema7Definition> | undefined,
): void {
  if (!definitions) return;
  for (const definition of Object.values(definitions)) {
    pushDefinition(children, definition);
  }
}

/** Every subschema directly nested in `schema`, in a stable discovery order. */
function childSchemas(schema: JSONSchema7): JSONSchema7[] {
  const children: JSONSchema7[] = [];
  pushDefinitionMap(children, schema.$defs);
  pushDefinitionMap(children, schema.definitions);
  pushDefinitionMap(children, schema.properties);
  pushDefinitionMap(children, schema.patternProperties);

  if (Array.isArray(schema.items)) {
    for (const item of schema.items) pushDefinition(children, item);
  } else {
    pushDefinition(children, schema.items);
  }

  for (const definition of [
    schema.additionalItems,
    schema.contains,
    schema.additionalProperties,
    schema.propertyNames,
    schema.if,
    schema.then,
    schema.else,
    schema.not,
  ]) {
    pushDefinition(children, definition);
  }

  for (const definition of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    pushDefinition(children, definition);
  }

  for (const dependency of Object.values(schema.dependencies ?? {})) {
    if (!Array.isArray(dependency)) pushDefinition(children, dependency);
  }

  return children;
}

function inventorySchema(
  schema: JSONSchema7,
  resolver: SchemaUriResolver,
): SchemaInventory {
  const resources = new Map<string, JSONSchema7>();
  const resourceParents = new Map<string, string | undefined>();
  const visited = new WeakSet<object>();
  const pending: PendingSchema[] = [
    { schema, baseId: "", resourceId: undefined },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.schema)) continue;
    visited.add(current.schema);

    let baseId = current.baseId;
    let resourceId = current.resourceId;
    if (typeof current.schema.$id === "string") {
      baseId = normalizeSchemaId(resolver, baseId, current.schema.$id);
      current.schema.$id = baseId;
      if (baseId.length > 0) {
        if (!resources.has(baseId)) {
          resources.set(baseId, current.schema);
          resourceParents.set(
            baseId,
            resourceId === baseId ? undefined : resourceId,
          );
        }
        resourceId = baseId;
      }
    }

    for (const child of childSchemas(current.schema)) {
      pending.push({ schema: child, baseId, resourceId });
    }
  }

  return { schema, resources, resourceParents };
}

function blockedResourceIds(
  inventory: SchemaInventory,
  unavailableIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const blocked = new Set<string>();

  for (const id of unavailableIds) {
    if (!inventory.resources.has(id)) continue;
    let parentId = inventory.resourceParents.get(id);
    while (parentId !== undefined && !blocked.has(parentId)) {
      blocked.add(parentId);
      parentId = inventory.resourceParents.get(parentId);
    }
  }

  return blocked;
}

interface CompileSchemaOptions extends AjvOptions {
  target: SchemaInventory;
  inventories: readonly SchemaInventory[];
}

function compileSchema({
  target,
  inventories,
  coerceTypes,
}: CompileSchemaOptions): ValidateFunction {
  const ajv = createAjv({ coerceTypes });
  const seenIds = new Set<string>();
  const ambiguousIds = new Set<string>();

  for (const inventory of inventories) {
    if (inventory === target) continue;

    for (const id of inventory.resources.keys()) {
      if (target.resources.has(id)) continue;
      if (seenIds.has(id)) {
        ambiguousIds.add(id);
      } else {
        seenIds.add(id);
      }
    }
  }

  const unavailableIds = new Set(target.resources.keys());
  for (const id of ambiguousIds) unavailableIds.add(id);
  const registrations: Array<readonly [string, JSONSchema7]> = [];
  for (const inventory of inventories) {
    if (inventory === target) continue;
    const blockedIds = blockedResourceIds(inventory, unavailableIds);
    for (const [id, schema] of inventory.resources) {
      if (!unavailableIds.has(id) && !blockedIds.has(id)) {
        registrations.push([id, schema]);
      }
    }
  }

  // Nested resources are discovered after their parents. Registering them in
  // reverse lets Ajv attach a parent without re-registering its child IDs.
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration) ajv.addSchema(registration[1], registration[0]);
  }
  for (const [id] of registrations) {
    ajv.getSchema(id);
  }
  return ajv.compile(target.schema);
}

function validationConfigError(
  option: string,
  received: unknown,
): SchmockError {
  return new SchmockError(
    `validationPlugin: ${option} must be a finite integer from 200 through 599`,
    "VALIDATION_CONFIG_INVALID",
    { option, received },
  );
}

function assertHttpStatus(
  value: unknown,
  option: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 200 ||
    value > 599
  ) {
    throw validationConfigError(option, value);
  }
}

type GraphClone = Record<string, unknown> | unknown[];

interface PendingClone {
  source: object;
  target: GraphClone;
}

function createGraphClone(source: object): GraphClone {
  return Array.isArray(source) ? new Array<unknown>(source.length) : {};
}

function readOwnValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  return "value" in descriptor
    ? descriptor.value
    : descriptor.get?.call(source);
}

// Schmock annotations can contain functions, while schema nodes can be shared
// or cyclic. Clone the graph iteratively and retain non-object values by identity.
function cloneGraph(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;

  const root = createGraphClone(value);
  const clones = new WeakMap<object, GraphClone>();
  const pending: PendingClone[] = [{ source: value, target: root }];
  clones.set(value, root);

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    for (const key of Object.keys(current.source)) {
      const sourceValue = readOwnValue(current.source, key);
      let clonedValue: unknown = sourceValue;

      if (typeof sourceValue === "object" && sourceValue !== null) {
        const existing = clones.get(sourceValue);
        if (existing) {
          clonedValue = existing;
        } else {
          const clone = createGraphClone(sourceValue);
          clones.set(sourceValue, clone);
          pending.push({ source: sourceValue, target: clone });
          clonedValue = clone;
        }
      }

      Object.defineProperty(current.target, key, {
        value: clonedValue,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return root;
}

function graphEquals(first: unknown, second: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[first, second]];
  const firstMatches = new WeakMap<object, object>();
  const secondMatches = new WeakMap<object, object>();

  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) continue;
    const [left, right] = pair;
    if (Object.is(left, right)) continue;
    if (
      typeof left !== "object" ||
      left === null ||
      typeof right !== "object" ||
      right === null ||
      Array.isArray(left) !== Array.isArray(right)
    ) {
      return false;
    }

    const matchedRight = firstMatches.get(left);
    if (matchedRight) {
      if (matchedRight !== right) return false;
      continue;
    }
    const matchedLeft = secondMatches.get(right);
    if (matchedLeft && matchedLeft !== left) return false;
    firstMatches.set(left, right);
    secondMatches.set(right, left);

    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false;
      pending.push([readOwnValue(left, key), readOwnValue(right, key)]);
    }
  }

  return true;
}

function headerCaseError(first: string, second: string): SchmockError {
  return new SchmockError(
    `validationPlugin: request.headers names "${first}" and "${second}", which are the same case-insensitive header`,
    "VALIDATION_CONFIG_INVALID",
    { option: "request.headers", received: [first, second] },
  );
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function namesDeclaredBy(schema: JSONSchema7): string[] {
  const names = [
    ...Object.keys(schema.properties ?? {}),
    ...stringEntries(schema.required),
  ];
  for (const [name, dependency] of Object.entries(schema.dependencies ?? {})) {
    names.push(name, ...stringEntries(dependency));
  }
  return names;
}

/**
 * Header names are case-insensitive and arrive lowercased, while a schema may
 * spell them `X-Api-Key`. Maps each lowercased name to the schema's own
 * spelling so incoming headers are keyed the way the schema expects. Header
 * values are strings, so every declared name anywhere in the schema graph
 * describes the header record itself.
 */
function headerNameSpellings(schema: JSONSchema7): ReadonlyMap<string, string> {
  const spellings = new Map<string, string>();
  const visited = new WeakSet<object>();
  const pending: JSONSchema7[] = [schema];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    for (const name of namesDeclaredBy(current)) {
      const folded = name.toLowerCase();
      const existing = spellings.get(folded);
      if (existing !== undefined && existing !== name) {
        throw headerCaseError(existing, name);
      }
      spellings.set(folded, name);
    }
    pending.push(...childSchemas(current));
  }

  return spellings;
}

function isSchema(value: unknown): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSchema(schema: JSONSchema7 | undefined): JSONSchema7 | undefined {
  if (schema === undefined) return undefined;
  const clone = cloneGraph(schema);
  if (!isSchema(clone)) throw new TypeError("Expected a schema object");
  return clone;
}

export function validationPlugin(
  options: ValidationPluginOptions,
): Schmock.Plugin {
  const requestErrorStatus =
    options.requestErrorStatus === undefined ? 400 : options.requestErrorStatus;
  const responseErrorStatus =
    options.responseErrorStatus === undefined
      ? 500
      : options.responseErrorStatus;
  assertHttpStatus(requestErrorStatus, "requestErrorStatus");
  assertHttpStatus(responseErrorStatus, "responseErrorStatus");

  const requestBodySchema = cloneSchema(options.request?.body);
  const requestQuerySchema = cloneSchema(options.request?.query);
  const requestHeadersSchema = cloneSchema(options.request?.headers);
  const responseBodySchema = cloneSchema(options.response?.body);
  const responseStatusScope = snapshotStatusScope(options.response?.statuses);
  const bodyRequired = options.request?.bodyRequired ?? false;
  const resolver = createAjv().opts.uriResolver;
  const requestBodyInventory = requestBodySchema
    ? inventorySchema(requestBodySchema, resolver)
    : undefined;
  const requestQueryInventory = requestQuerySchema
    ? inventorySchema(requestQuerySchema, resolver)
    : undefined;
  const requestHeadersInventory = requestHeadersSchema
    ? inventorySchema(requestHeadersSchema, resolver)
    : undefined;
  const responseBodyInventory = responseBodySchema
    ? inventorySchema(responseBodySchema, resolver)
    : undefined;
  const inventories: SchemaInventory[] = [];
  if (requestBodyInventory) inventories.push(requestBodyInventory);
  if (requestQueryInventory) inventories.push(requestQueryInventory);
  if (requestHeadersInventory) inventories.push(requestHeadersInventory);
  if (responseBodyInventory) inventories.push(responseBodyInventory);

  // Each slot compiles in its own registry, while unique sibling IDs are added
  // as references. This keeps duplicate root IDs isolated without losing refs.
  const validators: {
    requestBody?: ValidateFunction;
    requestQuery?: ValidateFunction;
    requestHeaders?: ValidateFunction;
    responseBody?: ValidateFunction;
  } = {};

  if (requestBodyInventory) {
    validators.requestBody = compileSchema({
      target: requestBodyInventory,
      inventories,
      coerceTypes: false,
    });
  }
  if (requestQueryInventory) {
    validators.requestQuery = compileSchema({
      target: requestQueryInventory,
      inventories,
      coerceTypes: true,
    });
  }
  if (requestHeadersInventory) {
    validators.requestHeaders = compileSchema({
      target: requestHeadersInventory,
      inventories,
      coerceTypes: true,
    });
  }
  if (responseBodyInventory) {
    validators.responseBody = compileSchema({
      target: responseBodyInventory,
      inventories,
      coerceTypes: false,
    });
  }
  const headerSpellings = requestHeadersSchema
    ? headerNameSpellings(requestHeadersSchema)
    : new Map<string, string>();

  // Only the original, unchanged rejection bypasses response validation once.
  const requestRejections = new WeakMap<object, unknown>();

  function rejectRequest(
    context: Schmock.PluginContext,
    error: string,
    code:
      | "REQUEST_VALIDATION_ERROR"
      | "QUERY_VALIDATION_ERROR"
      | "HEADER_VALIDATION_ERROR",
    details: unknown,
  ): Schmock.PluginResult {
    const response = {
      status: requestErrorStatus,
      body: { error, code, details },
    };
    requestRejections.set(response, cloneGraph(response));
    return {
      context,
      response,
    };
  }

  return {
    name: "validation",
    version: packageVersion,

    beforeRequest(context: Schmock.PluginContext): Schmock.PluginResult {
      if (context.body === undefined && bodyRequired) {
        return rejectRequest(
          context,
          "Request validation failed",
          "REQUEST_VALIDATION_ERROR",
          [
            {
              instancePath: "",
              keyword: "required",
              message: "request body is required",
            },
          ],
        );
      }

      // Optional bodies are skipped when absent, but every supplied body is
      // validated before route code can observe or mutate state from it.
      if (validators.requestBody && context.body !== undefined) {
        if (!validators.requestBody(context.body)) {
          return rejectRequest(
            context,
            "Request validation failed",
            "REQUEST_VALIDATION_ERROR",
            validators.requestBody.errors,
          );
        }
      }

      // Validate request query parameters. Ajv coerces in place, so a copy
      // keeps the strings the route and later plugins receive untouched.
      if (validators.requestQuery && context.query) {
        if (!validators.requestQuery({ ...context.query })) {
          return rejectRequest(
            context,
            "Query parameter validation failed",
            "QUERY_VALIDATION_ERROR",
            validators.requestQuery.errors,
          );
        }
      }

      // Validate request headers
      if (validators.requestHeaders && context.headers) {
        // Header names are case-insensitive: each one is keyed by the
        // schema's spelling of it, or lowercased when the schema never names
        // it. `Object.fromEntries` defines each key as an own data property,
        // so a header literally named `__proto__` lands in the record instead
        // of silently hitting `Object.prototype`'s setter — plain assignment
        // would drop it and let it escape `additionalProperties: false`. The
        // prototype is retained to match how core builds `context.headers`.
        const normalizedHeaders: Record<string, string> = Object.fromEntries(
          Object.entries(context.headers).map(([key, value]) => {
            const folded = key.toLowerCase();
            return [headerSpellings.get(folded) ?? folded, value];
          }),
        );
        if (!validators.requestHeaders(normalizedHeaders)) {
          return rejectRequest(
            context,
            "Header validation failed",
            "HEADER_VALIDATION_ERROR",
            validators.requestHeaders.errors,
          );
        }
      }

      return { context };
    },

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      if (
        typeof response === "object" &&
        response !== null &&
        requestRejections.has(response)
      ) {
        const snapshot = requestRejections.get(response);
        requestRejections.delete(response);
        if (graphEquals(response, snapshot)) return { context, response };
      }

      // Validate the semantic response body, including explicit no-content
      // results. Supported tuple and structured response forms carry metadata
      // around the body and must not be validated as the payload itself.
      //
      // "Semantic" means the value the generator and plugins produced, not the
      // serialized transport payload: core applies content-type conversion
      // (e.g. text/plain stringification) after the pipeline, so a `text/plain`
      // route validated against an object schema is delivered as a string.
      if (
        validators.responseBody &&
        isStatusInScope(responseStatusScope, getResponseStatus(response))
      ) {
        const responseBody = getResponseBody(response);

        if (!validators.responseBody(responseBody)) {
          return {
            context,
            response: {
              status: responseErrorStatus,
              body: {
                error: "Response validation failed",
                code: "RESPONSE_VALIDATION_ERROR",
                details: validators.responseBody.errors,
              },
            },
          };
        }
      }

      return { context, response };
    },
  };
}
