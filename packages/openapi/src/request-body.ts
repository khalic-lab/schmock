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

/**
 * Most bracket segments a key nests through, the depth core allows a JSON
 * body. Nesting, and every walk over the result, recurses once per level, so
 * a key of tens of thousands of segments overflowed the stack; a deeper key
 * stays literal instead.
 */
const MAX_BRACKET_DEPTH = 256;

/**
 * The OpenAPI `style` values an urlencoded property may declare in its media
 * type's `encoding` map: the query parameter styles.
 */
export type FormStyle =
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

/**
 * How an OpenAPI Encoding Object serializes one urlencoded property. Unset,
 * `style` is `form` and `explode` is true for `form`, false for the others.
 */
export interface FormEncoding {
  style: FormStyle;
  explode: boolean;
}

/** A media type's `encoding` map: each property name it names, and how. */
export type FormEncodingMap = ReadonlyMap<string, FormEncoding>;

/** The delimiter an array is joined with under a style that does not explode. */
const STYLE_DELIMITERS: Readonly<Partial<Record<FormStyle, string>>> = {
  form: ",",
  spaceDelimited: " ",
  pipeDelimited: "|",
};

/**
 * What core passes beside an urlencoded body, and the spec's reading of it:
 * the complete form (`RequestContext.form`) and the `encoding` map of the
 * media type the body was matched to.
 */
export interface SubmittedForm {
  fields?: Schmock.ReadonlyURLSearchParams;
  encoding?: FormEncodingMap;
}

/** True for the media types core decodes into form fields. */
export function isFormMediaType(mediaType: string): boolean {
  return (
    mediaType === URLENCODED_MEDIA_TYPE || mediaType.startsWith("multipart/")
  );
}

/** True for the media types core parses as JSON. */
export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
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
 * - An urlencoded record that `form.fields` describes (see
 *   {@link SubmittedForm}) is read from those fields instead, so a repeated
 *   name and a delimited value become arrays the way `form.encoding` says.
 *   An urlencoded record read alone (Express, or no form that describes it)
 *   still has a delimited value split, where `form.encoding` says the
 *   property does not explode (see {@link splitDelimitedFields}).
 *
 * Files (`Blob`/`File`) are kept as they are. Every other body (JSON, text,
 * bytes) is returned unchanged.
 */
export function normalizeRequestBody(
  body: unknown,
  contentType: string | undefined,
  schema: JSONSchema7 | undefined,
  form?: SubmittedForm,
): unknown {
  const fields =
    submittedFields(body, contentType, schema, form) ??
    recordFields(body, contentType, schema, form?.encoding) ??
    formFields(body, contentType);
  if (fields === undefined) return body;
  return coerceObject(nestBracketKeys(fields, schema), schema);
}

/**
 * The body a CRUD generator should store: the value request validation already
 * normalized for this request, or the same normalization run now when
 * `validateRequests` is off.
 */
export function readRequestBody(
  ctx: Pick<
    Schmock.RequestContext,
    "body" | "form" | "headers" | "pluginState"
  >,
  schema: JSONSchema7 | undefined,
  encoding?: FormEncodingMap,
): unknown {
  if (ctx.pluginState?.has(NORMALIZED_BODY_STATE_KEY)) {
    return ctx.pluginState.get(NORMALIZED_BODY_STATE_KEY);
  }
  return normalizeRequestBody(
    ctx.body,
    getHeader(ctx.headers, "content-type"),
    schema,
    { fields: ctx.form, encoding },
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
  [Symbol.iterator](): Iterator<[string, unknown]>;
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
    typeof (value as Partial<Iterable<unknown>>)[Symbol.iterator] === "function"
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
    // One pass over the entries: `getAll()` per name scans the whole form
    // each time, so a body of many fields would take quadratic time.
    const groups = new Map<string, unknown[]>();
    for (const [name, value] of body) {
      const values = groups.get(name);
      if (values === undefined) groups.set(name, [value]);
      else values.push(value);
    }
    const fields: Record<string, unknown> = {};
    for (const [name, values] of groups) {
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
 * The fields of an urlencoded body read from the complete form core passed
 * beside it, or `undefined` to read the body record alone: without a form,
 * for any other media type, and when the form no longer describes the record
 * (a plugin replaced or edited the body), since the record is then what the
 * route receives.
 *
 * Each name takes the value its schema reads: every value of a name sent more
 * than once, or a non-exploded value split on its style's delimiter, where
 * the property is declared as an array; the last value, as the record holds
 * it, everywhere else.
 */
function submittedFields(
  body: unknown,
  contentType: string | undefined,
  schema: JSONSchema7 | undefined,
  form: SubmittedForm | undefined,
): Record<string, unknown> | undefined {
  if (form?.fields === undefined || contentType === undefined) return undefined;
  if (normalizeMediaType(contentType) !== URLENCODED_MEDIA_TYPE) {
    return undefined;
  }
  if (!isPlainRecord(body)) return undefined;
  const groups = groupFormFields(form.fields);
  if (groups === undefined || !describesRecord(groups, body)) return undefined;

  const schemas = fieldSchemas(schema);
  const fields: Record<string, unknown> = {};
  for (const [name, values] of groups) {
    defineField(
      fields,
      name,
      submittedValue(name, values, schemas, form.encoding),
    );
  }
  return fields;
}

/**
 * The fields of an urlencoded body record read without the form, with every
 * value a non-exploding encoding joined split on its delimiter (see
 * {@link splitDelimitedFields}), or `undefined` when the media type declares
 * no encoding, and {@link formFields} copies the record as it is.
 */
function recordFields(
  body: unknown,
  contentType: string | undefined,
  schema: JSONSchema7 | undefined,
  encoding: FormEncodingMap | undefined,
): Record<string, unknown> | undefined {
  if (encoding === undefined || contentType === undefined) return undefined;
  if (normalizeMediaType(contentType) !== URLENCODED_MEDIA_TYPE) {
    return undefined;
  }
  if (!isPlainRecord(body)) return undefined;
  return splitDelimitedFields({ ...body }, schema, encoding);
}

/**
 * `fields` with each string value split on its delimiter where the property
 * is declared as an array and its `encoding` entry does not explode: `form`
 * with `explode: false` (`tags=a,b`), or `spaceDelimited` or `pipeDelimited`.
 * Express's parser, and a `handle()` caller passing a record, hand such a
 * value over joined, as it was sent. A property with no `encoding` entry
 * explodes, by OpenAPI's default for `form`, and keeps its value. Only a
 * top-level property can name an encoding, as when the form is read.
 */
function splitDelimitedFields(
  fields: Record<string, unknown>,
  schema: JSONSchema7 | undefined,
  encoding: FormEncodingMap,
): Record<string, unknown> {
  const schemas = fieldSchemas(schema);
  for (const [name, style] of encoding) {
    const delimiter = style.explode ? undefined : STYLE_DELIMITERS[style.style];
    if (delimiter === undefined || !Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    if (typeof value !== "string" || value === "") continue;
    if (!admitsType(schemas.of(name), "array")) continue;
    const parts = value.split(delimiter);
    // One value stays a string, exactly as the record holds it.
    defineField(fields, name, parts.length === 1 ? parts[0] : parts);
  }
  return fields;
}

/**
 * Every value of each name, in the order the names first appear, read in one
 * pass over the form: `getAll()` per name scans the whole form each time, so
 * a body of many fields would take quadratic time.
 */
function groupFormFields(
  form: Schmock.ReadonlyURLSearchParams,
): Map<string, string[]> | undefined {
  // `form` is whatever a handle() caller passed, `null` or a string included;
  // core's own is a URLSearchParams. `getAll` only marks the shape here.
  if (
    typeof form?.[Symbol.iterator] !== "function" ||
    typeof form.getAll !== "function"
  ) {
    return undefined;
  }
  const groups = new Map<string, string[]>();
  for (const [name, value] of form) {
    const values = groups.get(name);
    if (values === undefined) groups.set(name, [value]);
    else values.push(value);
  }
  return groups;
}

/** True when `record` holds exactly the last value of every name in `groups`. */
function describesRecord(
  groups: ReadonlyMap<string, string[]>,
  record: Record<string, unknown>,
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== groups.size) return false;
  return keys.every((key) => {
    const values = groups.get(key);
    return values !== undefined && values[values.length - 1] === record[key];
  });
}

function submittedValue(
  name: string,
  values: string[],
  schemas: FieldSchemas,
  encoding: FormEncodingMap | undefined,
): unknown {
  const target = submittedTarget(name, schemas);
  if (!admitsType(target.schema, "array")) return values[values.length - 1];
  // Only a top-level property can name an encoding; a bracket key is
  // OpenAPI's deepObject, whose names carry the structure themselves.
  const style = target.topLevel ? encoding?.get(name) : undefined;
  const delimiter =
    style === undefined || style.explode
      ? undefined
      : STYLE_DELIMITERS[style.style];
  const decoded =
    delimiter === undefined
      ? values
      : values.flatMap((value) =>
          value === "" ? [value] : value.split(delimiter),
        );
  // One value stays a string, exactly as the record holds it.
  return decoded.length === 1 ? decoded[0] : decoded;
}

/**
 * The schema a field name is read through: its property's, or for a bracket
 * key that nests (see {@link bracketPath}) the schema at the end of its path.
 * A trailing `[]` appends to the array it names, so that array is the target.
 */
function submittedTarget(
  name: string,
  schemas: FieldSchemas,
): { schema: JSONSchema7 | undefined; topLevel: boolean } {
  const path = bracketPath(name, schemas);
  if (path === undefined) return { schema: schemas.of(name), topLevel: true };
  const [base, ...segments] = path;
  if (segments[segments.length - 1] === "") segments.pop();
  let schema = schemas.of(base);
  for (const segment of segments) schema = childSchema(schema, segment);
  return { schema, topLevel: false };
}

/** The schema of `segment` inside a container, as `finishNode` reads it. */
function childSchema(
  schema: JSONSchema7 | undefined,
  segment: string,
): JSONSchema7 | undefined {
  if (admitsType(schema, "array") && !admitsObject(schema)) {
    return itemSchema(schema);
  }
  return fieldSchemas(schema).of(segment);
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

/** True when the schema or one of its branches declares `type`. */
export function admitsType(
  schema: JSONSchema7 | undefined,
  type: string,
): boolean {
  return branchesOf(schema).some((branch) => hasType(branch, type));
}

/**
 * True when no branch of the schema declares a `type`, so a value of any type
 * can satisfy it: `{ maxLength: 2 }` still checks a string.
 */
export function isUntyped(schema: JSONSchema7 | undefined): boolean {
  return branchesOf(schema).every((branch) => branch.type === undefined);
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

/**
 * How many values each node has had appended through `name[]`. Counting the
 * node's keys on every append instead took quadratic time in the values.
 */
const appendCounts = new WeakMap<Record<string, unknown>, number>();

/**
 * `[base, ...segments]` for a bracket key that nests: its base is a declared
 * object or array property, the key itself is not declared, and it has at
 * most {@link MAX_BRACKET_DEPTH} segments. `undefined` for a key that stays
 * literal.
 */
function bracketPath(key: string, schemas: FieldSchemas): string[] | undefined {
  if (schemas.declared.has(key)) return undefined;
  const match = BRACKET_KEY.exec(key);
  const base = match?.[1];
  if (!match || base === undefined || !schemas.declared.has(base)) {
    return undefined;
  }
  const baseSchema = schemas.of(base);
  if (!(admitsObject(baseSchema) || admitsType(baseSchema, "array"))) {
    return undefined;
  }
  const segments = [...match[2].matchAll(BRACKET_SEGMENT)].map((m) => m[1]);
  if (segments.length > MAX_BRACKET_DEPTH) return undefined;
  return [base, ...segments];
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
    const path = bracketPath(key, schemas);
    if (path === undefined) {
      literal(key, value);
      continue;
    }
    bracketed.push([path, key, value]);
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
  // An append key never collides with a sent segment, which holds no `[`.
  const appended = Array.isArray(value) ? value : [value];
  let count = appendCounts.get(node) ?? 0;
  for (const entry of appended) {
    defineField(node, `[]${count++}`, entry);
  }
  appendCounts.set(node, count);
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

  // A file validates as a string (see toValidationInstance), so a lone file
  // under an array of files is that array's one element, as a string is.
  if (
    isBinaryPayload(value) &&
    admitsType(schema, "array") &&
    !admitsType(schema, "string")
  ) {
    return [coerceField(value, itemSchema(schema))];
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
