import type * as Schmock from "@schmock/core";
import { getHeader, isBinaryBody } from "@schmock/core";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { hasType, isRecord, normalizeMediaType } from "./utils.js";

/*
 * The request body as the operation's schema reads it.
 *
 * Core decodes a body by media type and stops there: an urlencoded form is a
 * record of strings, a multipart form is a `FormData`. Neither is the instance
 * the spec describes, so validating either as-is rejected valid form posts and
 * let invalid ones through. This module turns those two shapes into the
 * record the schema means, once: request validation checks that value, and
 * keeps it for the CRUD generators to read through `readRequestBody()`.
 */

/**
 * Where request validation leaves the normalized body for the route's
 * generator: `PluginContext.state`, which the generator sees as
 * `RequestContext.pluginState`. Set only when `validateRequests` ran; read it
 * through {@link readRequestBody}, which normalizes on the spot otherwise.
 */
export const NORMALIZED_BODY_STATE_KEY = "openapi:normalizedBody";

const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

/**
 * Plain decimal notation, the only numeric spelling a form field is coerced
 * from. The same rule @schmock/validation applies to query and header values:
 * `Number()` alone would also read `""`, `" 7 "`, `0x10` and `1e400`.
 */
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** `name[a][0]` → base `name`, segments `["a", "0"]`; `name[]` → `[""]`. */
const BRACKET_KEY = /^([^[\]]+)((?:\[[^[\]]*\])+)$/;
const BRACKET_SEGMENT = /\[([^[\]]*)\]/g;

/** True for the media types core decodes into form fields. */
export function isFormMediaType(mediaType: string): boolean {
  return (
    mediaType === URLENCODED_MEDIA_TYPE || mediaType.startsWith("multipart/")
  );
}

/**
 * The request body in the shape `schema` describes.
 *
 * - A `FormData` (multipart on every transport) or `URLSearchParams` becomes a
 *   plain record; a name sent more than once becomes an array of its values.
 * - A form record (urlencoded, or multipart already parsed by an Express
 *   middleware) is copied, never changed in place.
 * - Bracket keys are nested when the schema declares their base property as an
 *   object or array and does not declare the literal key: `metadata[order]=42`
 *   becomes `{ metadata: { order: "42" } }`, `tags[]=a` becomes `{ tags: ["a"] }`.
 *   OpenAPI's `deepObject` encoding and the common `name[0]` convention both
 *   arrive this way.
 * - String fields are coerced by the type their property declares: a plain
 *   decimal to a number, `true`/`false` to a boolean, `""` to `null`, and one
 *   value to a one-element array. A string the type cannot take stays a
 *   string, so validation reports the real mismatch.
 *
 * Files (`Blob`/`File`) are kept as they are. Every other body (JSON, text,
 * bytes) is returned unchanged.
 */
export function normalizeRequestBody(
  body: unknown,
  contentType: string | undefined,
  schema: JSONSchema7 | undefined,
): unknown {
  const fields = formFields(body, contentType);
  if (fields === undefined) return body;
  return coerceObject(nestBracketKeys(fields, schema), schema);
}

/**
 * The body a CRUD generator should store: the value request validation already
 * normalized for this request, or the same normalization run now when
 * `validateRequests` is off.
 */
export function readRequestBody(
  ctx: Pick<Schmock.RequestContext, "body" | "headers" | "pluginState">,
  schema: JSONSchema7 | undefined,
): unknown {
  if (ctx.pluginState?.has(NORMALIZED_BODY_STATE_KEY)) {
    return ctx.pluginState.get(NORMALIZED_BODY_STATE_KEY);
  }
  return normalizeRequestBody(
    ctx.body,
    getHeader(ctx.headers, "content-type"),
    schema,
  );
}

/**
 * Longest stand-in string a file part becomes, in characters. Large enough for
 * the `maxLength` an upload schema realistically sets, small enough that a big
 * upload does not allocate its whole size again as a string.
 */
const MAX_FILE_STAND_IN_LENGTH = 64 * 1024 * 1024;

/**
 * The normalized body as Ajv should see it: every file part becomes a string
 * as long as its size in bytes, capped at {@link MAX_FILE_STAND_IN_LENGTH}. A
 * multipart file is how OpenAPI's `type: string, format: binary` arrives, and
 * Ajv would reject the `Blob` as "must be string"; the length keeps
 * `minLength` and `maxLength` meaningful for it. A file sent where the schema
 * wants a number still fails, as a string.
 */
export function toValidationInstance(value: unknown): unknown {
  if (isBinaryPayload(value)) {
    return "\0".repeat(Math.min(byteSize(value), MAX_FILE_STAND_IN_LENGTH));
  }
  if (Array.isArray(value)) return value.map(toValidationInstance);
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineField(copy, key, toValidationInstance(entry));
    }
    return copy;
  }
  return value;
}

/** Bytes in any of the shapes a transport hands over: buffers, views, Blobs. */
export function isBinaryPayload(value: unknown): boolean {
  return (
    isBinaryBody(value) || (typeof Blob === "function" && value instanceof Blob)
  );
}

function byteSize(value: unknown): number {
  if (typeof Blob === "function" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return 0;
}

function hasTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`;
}

interface MultiValueFields {
  keys(): IterableIterator<string>;
  getAll(name: string): unknown[];
}

// Tag checks rather than `instanceof`: Angular, jsdom and undici may each
// construct the FormData a body arrives as.
function isMultiValueFields(value: unknown): value is MultiValueFields {
  if (!hasTag(value, "FormData") && !hasTag(value, "URLSearchParams")) {
    return false;
  }
  return (
    isRecord(value) &&
    typeof value.getAll === "function" &&
    typeof value.keys === "function"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) && !isBinaryPayload(value) && !isMultiValueFields(value)
  );
}

function formFields(
  body: unknown,
  contentType: string | undefined,
): Record<string, unknown> | undefined {
  if (isMultiValueFields(body)) {
    const fields: Record<string, unknown> = {};
    for (const name of new Set(body.keys())) {
      const values = body.getAll(name);
      defineField(fields, name, values.length === 1 ? values[0] : values);
    }
    return fields;
  }
  if (
    contentType !== undefined &&
    isFormMediaType(normalizeMediaType(contentType)) &&
    isPlainRecord(body)
  ) {
    return { ...body };
  }
  return undefined;
}

/**
 * Own data property, whatever the key: a form may legitimately carry a field
 * named `__proto__`, and plain assignment would replace the prototype instead.
 */
function defineField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function asSchema(definition: JSONSchema7Definition | undefined) {
  return typeof definition === "object" ? definition : undefined;
}

/**
 * The schema and every `allOf`/`anyOf`/`oneOf` branch under it: what a value
 * of this schema may be. Dereferenced specs can be cyclic, hence `seen`.
 */
function branchesOf(schema: JSONSchema7 | undefined): JSONSchema7[] {
  const branches: JSONSchema7[] = [];
  const seen = new Set<JSONSchema7>();
  const visit = (node: JSONSchema7) => {
    if (seen.has(node)) return;
    seen.add(node);
    branches.push(node);
    for (const branch of [
      ...(node.allOf ?? []),
      ...(node.anyOf ?? []),
      ...(node.oneOf ?? []),
    ]) {
      const branchSchema = asSchema(branch);
      if (branchSchema) visit(branchSchema);
    }
  };
  if (schema) visit(schema);
  return branches;
}

function admitsType(schema: JSONSchema7 | undefined, type: string): boolean {
  return branchesOf(schema).some((branch) => hasType(branch, type));
}

function admitsObject(schema: JSONSchema7 | undefined): boolean {
  return branchesOf(schema).some(
    (branch) => hasType(branch, "object") || isRecord(branch.properties),
  );
}

function itemSchema(schema: JSONSchema7 | undefined): JSONSchema7 | undefined {
  for (const branch of branchesOf(schema)) {
    const items = Array.isArray(branch.items)
      ? undefined
      : asSchema(branch.items);
    if (items) return items;
  }
  return undefined;
}

interface FieldSchemas {
  /** Names some branch declares under `properties`. */
  declared: Set<string>;
  /** The declared property, else the first `additionalProperties` schema. */
  of(name: string): JSONSchema7 | undefined;
}

/** Every property any branch declares; the first declaration wins. */
function fieldSchemas(schema: JSONSchema7 | undefined): FieldSchemas {
  const properties = new Map<string, JSONSchema7>();
  let additional: JSONSchema7 | undefined;
  for (const branch of branchesOf(schema)) {
    for (const [name, definition] of Object.entries(branch.properties ?? {})) {
      const property = asSchema(definition);
      if (property && !properties.has(name)) properties.set(name, property);
    }
    additional ??= asSchema(branch.additionalProperties);
  }
  return {
    declared: new Set(properties.keys()),
    of: (name) => properties.get(name) ?? additional,
  };
}

/**
 * A container built from bracket keys. Its own class so a nested object an
 * Express `extended` parser already built is never mistaken for one.
 */
class BracketNode {
  [key: string]: unknown;
}

function nestBracketKeys(
  fields: Record<string, unknown>,
  schema: JSONSchema7 | undefined,
): Record<string, unknown> {
  const schemas = fieldSchemas(schema);
  const nested: Record<string, unknown> = {};
  const literal = (key: string, value: unknown) => {
    defineField(nested, key, value);
  };

  // Literal keys go in first, so a bracket key whose base was also sent as a
  // plain field stays literal whichever of the two came first.
  const bracketed: Array<[string[], string, unknown]> = [];
  for (const [key, value] of Object.entries(fields)) {
    const match = schemas.declared.has(key) ? null : BRACKET_KEY.exec(key);
    const base = match?.[1];
    const baseSchema =
      base !== undefined && schemas.declared.has(base)
        ? schemas.of(base)
        : undefined;
    if (
      !match ||
      base === undefined ||
      !(admitsObject(baseSchema) || admitsType(baseSchema, "array"))
    ) {
      literal(key, value);
      continue;
    }
    const segments = [...match[2].matchAll(BRACKET_SEGMENT)].map((m) => m[1]);
    bracketed.push([[base, ...segments], key, value]);
  }

  for (const [path, key, value] of bracketed) {
    if (!insertAtPath(nested, path, value)) literal(key, value);
  }

  for (const [key, value] of Object.entries(nested)) {
    if (value instanceof BracketNode) {
      defineField(nested, key, finishNode(value, schemas.of(key)));
    }
  }
  return nested;
}

/**
 * Place `value` at `path`, creating bracket nodes on the way. False when a
 * plain value already holds a slot the path runs through, so the caller keeps
 * the key as it was sent.
 */
function insertAtPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): boolean {
  let node: Record<string, unknown> = root;
  for (const segment of path.slice(0, -1)) {
    const next = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (next === undefined) {
      const created = new BracketNode();
      defineField(node, segment, created);
      node = created;
    } else if (next instanceof BracketNode) {
      node = next;
    } else {
      return false;
    }
  }

  const last = path[path.length - 1];
  if (last !== "") {
    if (Object.hasOwn(node, last)) return false;
    defineField(node, last, value);
    return true;
  }
  // `name[]` appends; a name repeated in a FormData appends each value.
  // String keys keep insertion order and sort after integer keys, which is
  // the order `finishNode` reads an array node in.
  const appended = Array.isArray(value) ? value : [value];
  for (const entry of appended) {
    defineField(node, `[]${Object.keys(node).length}`, entry);
  }
  return true;
}

function finishNode(
  node: BracketNode,
  schema: JSONSchema7 | undefined,
): unknown {
  const finish = (value: unknown, child: JSONSchema7 | undefined) =>
    value instanceof BracketNode ? finishNode(value, child) : value;

  if (admitsType(schema, "array") && !admitsObject(schema)) {
    const items = itemSchema(schema);
    return Object.values(node).map((value) => finish(value, items));
  }

  const fields = fieldSchemas(schema);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    defineField(result, key, finish(value, fields.of(key)));
  }
  return result;
}

function coerceObject(
  record: Record<string, unknown>,
  schema: JSONSchema7 | undefined,
): Record<string, unknown> {
  const fields = fieldSchemas(schema);
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    defineField(coerced, key, coerceField(value, fields.of(key)));
  }
  return coerced;
}

function coerceField(value: unknown, schema: JSONSchema7 | undefined): unknown {
  if (!schema) return value;

  if (Array.isArray(value)) {
    if (!admitsType(schema, "array")) return value;
    const items = itemSchema(schema);
    return value.map((entry) => coerceField(entry, items));
  }

  if (typeof value === "string") {
    if (admitsType(schema, "array") && !acceptsText(schema, value)) {
      return [coerceField(value, itemSchema(schema))];
    }
    return coerceText(value, schema);
  }

  if (isPlainRecord(value) && admitsObject(schema)) {
    return coerceObject(value, schema);
  }
  return value;
}

/**
 * True when some string branch of `schema` takes `text` as sent. A branch with
 * `enum`, `const` or `pattern` takes only the text those allow, so Stripe's
 * `anyOf: [{ type: integer }, { type: string, enum: [""] }]` keeps `""` as
 * text but reads `100` as the integer. A bare `type: string` takes any text,
 * which keeps `007` a string wherever a string is allowed.
 */
function acceptsText(schema: JSONSchema7, text: string): boolean {
  return branchesOf(schema).some(
    (branch) =>
      hasType(branch, "string") &&
      (!Array.isArray(branch.enum) || branch.enum.includes(text)) &&
      (branch.const === undefined || branch.const === text) &&
      (typeof branch.pattern !== "string" ||
        matchesPattern(branch.pattern, text)),
  );
}

/**
 * `pattern` read as validation compiles it: with the `u` flag when the pattern
 * allows, without it otherwise. A pattern neither grammar accepts counts as a
 * match, and validation reports it as the schema error it is.
 */
function matchesPattern(pattern: string, text: string): boolean {
  for (const flags of ["u", ""]) {
    let regExp: RegExp;
    try {
      regExp = new RegExp(pattern, flags);
    } catch {
      continue;
    }
    return regExp.test(text);
  }
  return true;
}

/** A string field read as the scalar type its schema declares, if it can be. */
function coerceText(text: string, schema: JSONSchema7): unknown {
  if (acceptsText(schema, text)) return text;
  if (
    (admitsType(schema, "integer") || admitsType(schema, "number")) &&
    PLAIN_DECIMAL.test(text)
  ) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  if (admitsType(schema, "boolean") && (text === "true" || text === "false")) {
    return text === "true";
  }
  if (admitsType(schema, "null") && text === "") return null;
  return text;
}
