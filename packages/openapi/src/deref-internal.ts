import { SchmockError } from "@schmock/core";

/**
 * `$ref` dereferencing for pointers that stay inside one document.
 *
 * This exists so a spec object can be resolved without
 * `@apidevtools/json-schema-ref-parser`, which reaches `require("path")` in
 * three places and declares no `browser` mapping covering it. That import is
 * what breaks a browser bundle, and no bundler configuration can reach inside
 * a dependency's CommonJS `require` to fix it.
 *
 * It is a deliberate re-implementation of ref-parser 14.0.1's behaviour, not an
 * improvement on it. Every quirk reproduced here is one the rest of this
 * package has always been fed and is therefore built around — most sharply the
 * two cycle behaviours noted on {@link dereferenceInternal}.
 * `deref-parity.test.ts` runs the same documents through both implementations
 * and asserts the results are indistinguishable, so a divergence fails the
 * build instead of reaching a browser.
 *
 * External refs are out of scope by construction: `parseSpec` rules on them
 * through the ref policy before dereferencing starts, and the browser resolver
 * refuses them outright.
 */

/** A `$ref` object as ref-parser recognises one: a non-empty string `$ref`. */
interface RefObject {
  $ref: string;
  [key: string]: unknown;
}

interface Resolved {
  value: unknown;
  /** Pointer of the target, after any chained `$ref`s were followed. */
  path: string;
  /** The target is a `$ref` naming its own location. */
  circular: boolean;
}

interface Dereferenced {
  value: unknown;
  circular: boolean;
}

/**
 * Distinguishes "the pointer resolved to JSON `null`" from "the pointer
 * resolved to nothing", which a bare `null` cannot express.
 */
const NULL_TARGET = Symbol("null");

/**
 * Ceiling on `$ref`-to-`$ref` hops.
 *
 * ref-parser counts indirections without bounding them and hangs on a ring of
 * refs that never reaches a value. Failing loudly is the better answer, and the
 * limit is far above any real document.
 */
const MAX_REF_HOPS = 100;

function isRefObject(value: unknown): value is RefObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string" &&
    (value as { $ref: string }).$ref.length > 0
  );
}

/** A pointer into the document itself, as opposed to another file or a URL. */
function isInternalRef(value: unknown): value is RefObject {
  return (
    isRefObject(value) && (value.$ref.startsWith("#/") || value.$ref === "#")
  );
}

/**
 * A `$ref` carrying sibling keys, which OAS 3.1 allows.
 *
 * It does not point at its target, it derives a NEW object from it, so it can
 * never share identity with anything.
 */
function isExtendedRef(value: RefObject): boolean {
  return Object.keys(value).length > 1;
}

function isWalkable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !ArrayBuffer.isView(value)
  );
}

function refError(message: string, ref: string): SchmockError {
  return new SchmockError(message, "OPENAPI_INVALID_REF", { ref });
}

/**
 * Split a pointer into its decoded tokens.
 *
 * The unescape order is ref-parser's and is not RFC 6901's: `~1` becomes a
 * slash before `~0` becomes a tilde, so `~01` decodes to `~1` rather than to a
 * slash. Percent-decoding runs last, and a malformed sequence keeps its literal
 * text instead of throwing.
 */
function parseTokens(pointer: string): string[] {
  const hash = pointer.indexOf("#");
  const fragment = hash === -1 ? "" : pointer.slice(hash + 1);
  if (fragment === "") return [];

  const parts = fragment.split("/");
  if (parts[0] !== "") {
    throw refError(`invalid $ref pointer "${pointer}"`, pointer);
  }
  return parts.slice(1).map((part) => {
    const unescaped = part.replaceAll("~1", "/").replaceAll("~0", "~");
    try {
      return decodeURIComponent(unescaped);
    } catch {
      return unescaped;
    }
  });
}

/** Re-encode tokens onto a pointer. Inverse of {@link parseTokens}. */
function joinPointer(base: string, tokens: string[]): string {
  let path = base.includes("#") ? base : `${base}#`;
  for (const token of tokens) {
    const escaped = token.replaceAll("~", "~0").replaceAll("/", "~1");
    path += `/${encodeURIComponent(escaped)}`;
  }
  return path;
}

/**
 * Shallow-merge a `$ref`'s siblings over its target.
 *
 * Siblings win; the target fills in the keys they do not mention. Mirrors
 * ref-parser's `$Ref.dereference`.
 */
function mergeExtendedRef(ref: RefObject, target: unknown): unknown {
  if (!isWalkable(target)) return target;
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(ref)) {
    if (key !== "$ref") merged[key] = ref[key];
  }
  for (const key of Object.keys(target)) {
    if (!(key in merged)) merged[key] = target[key];
  }
  return merged;
}

/**
 * Walk one pointer to its target, following any `$ref` met on the way.
 *
 * A `$ref` naming its own location ends the walk and reports `circular`
 * rather than looping.
 */
function resolvePointer(document: unknown, refPath: string): Resolved {
  const tokens = parseTokens(refPath);
  let value: unknown = document;
  let path = refPath;
  let circular = false;
  let hops = 0;

  /**
   * Follow `value` while it is itself a `$ref`. Reports whether the resolution
   * path moved, which means the tokens still to be consumed have to be
   * re-anchored onto the new path.
   */
  const followRefs = (atRoot: boolean): boolean => {
    let moved = false;
    while (isInternalRef(value)) {
      if (++hops > MAX_REF_HOPS) {
        throw refError(
          `$ref "${refPath}" chains through more than ${MAX_REF_HOPS} references`,
          refPath,
        );
      }
      const target = value.$ref;
      if (target === path && !atRoot) {
        // Points at itself. ref-parser stops here and leaves the `$ref` in
        // place rather than building a one-node cycle.
        circular = true;
        return moved;
      }
      const next = resolvePointer(document, target);
      if (isExtendedRef(value)) {
        // The siblings derive a new object, so the path does NOT move: only
        // the value changes.
        value = mergeExtendedRef(value, next.value);
        return moved;
      }
      value = next.value;
      path = next.path;
      moved = true;
    }
    return moved;
  };

  for (let i = 0; i < tokens.length; i++) {
    if (followRefs(false)) path = joinPointer(path, tokens.slice(i));

    const token = tokens[i];
    if (!isWalkable(value)) {
      throw refError(`$ref "${refPath}" has no "${token}"`, refPath);
    }

    const next = value[token];
    if (next !== undefined && !(next === null && i === tokens.length - 1)) {
      value = next;
      continue;
    }

    // A key containing a literal slash was split across several tokens. Try
    // re-joining the longest run that names a real key; ref-parser does the
    // same and hand-written specs rely on it.
    const container = value;
    let rejoined = false;
    for (let j = tokens.length - 1; j > i; j--) {
      const candidate = tokens.slice(i, j + 1).join("/");
      if (container[candidate] !== undefined) {
        value = container[candidate];
        i = j;
        rejoined = true;
        break;
      }
    }
    if (rejoined) continue;

    // A key that is present and explicitly `null` is a hit, not a miss.
    if (token in container && container[token] === null) {
      value = NULL_TARGET;
      continue;
    }

    throw refError(`$ref "${refPath}" has no "${token}"`, refPath);
  }

  followRefs(tokens.length === 0);
  return {
    value: value === NULL_TARGET ? null : value,
    path,
    circular,
  };
}

/**
 * Replace every internal `$ref` in `document` with its target, in place.
 *
 * Two behaviours are load-bearing and are not accidents of the port:
 *
 * - An indirect cycle (`A` → `B` → `A`) becomes a REAL object cycle. The
 *   normalizer breaks it by identity — it keeps an on-stack `Set` — and
 *   `collectUnresolvedRefs` walks with a `WeakSet` for the same reason, so a
 *   dereferencer that cloned per ref-site rather than sharing one object would
 *   defeat both and recurse forever.
 * - A `$ref` naming its own location is LEFT in the document, rewritten to its
 *   path from the root. Inlining it would change what `normalizeSchema`, AJV
 *   and the faker generator have always been handed.
 */
export function dereferenceInternal<T>(document: T): T {
  /** Objects on the current crawl stack, which is how a cycle is recognised. */
  const parents = new Set<object>();
  const processed = new Set<object>();
  /**
   * Keyed by pointer text, so two spellings of one pointer get separate
   * entries. That is ref-parser's behaviour too, and is why identity sharing is
   * best-effort rather than guaranteed.
   */
  const cache = new Map<string, Dereferenced>();

  const expandRef = (ref: RefObject, pathFromRoot: string): Dereferenced => {
    const refPath = ref.$ref;
    const cached = cache.get(refPath);
    if (cached !== undefined) {
      if (cached.circular || Object.keys(ref).length === 1) return cached;
      // Siblings alongside a cached target still have to be merged, and that
      // merge produces a fresh object every time.
      const extra: Record<string, unknown> = {};
      for (const key of Object.keys(ref)) {
        if (key === "$ref") continue;
        if (!isWalkable(cached.value) || !(key in cached.value)) {
          extra[key] = ref[key];
        }
      }
      return {
        circular: false,
        value: isWalkable(cached.value)
          ? Object.assign({}, cached.value, extra)
          : cached.value,
      };
    }

    const pointer = resolvePointer(document, refPath);
    const directCircular = pointer.circular;
    let circular = directCircular || parents.has(pointer.value as object);

    let value = isExtendedRef(ref)
      ? mergeExtendedRef(ref, pointer.value)
      : pointer.value;

    if (!circular) {
      const dereferenced = crawl(value, pointer.path, pathFromRoot);
      circular = dereferenced.circular;
      value = dereferenced.value;
    }

    if (directCircular && isWalkable(value)) {
      value.$ref = pathFromRoot;
    }

    const dereferenced: Dereferenced = { circular, value };
    // Only a bare `$ref` is cacheable: an extended one derives a new object per
    // site, so caching it would hand two sites the same merged object.
    if (Object.keys(ref).length === 1) cache.set(refPath, dereferenced);
    return dereferenced;
  };

  function crawl(
    node: unknown,
    path: string,
    pathFromRoot: string,
  ): Dereferenced {
    const result: Dereferenced = { value: node, circular: false };
    if (!isWalkable(node) || processed.has(node)) return result;

    parents.add(node);
    processed.add(node);

    if (isInternalRef(node)) {
      const dereferenced = expandRef(node, pathFromRoot);
      result.value = dereferenced.value;
      result.circular = dereferenced.circular;
    } else {
      for (const key of Object.keys(node)) {
        const child = node[key];
        let circular = false;

        if (isInternalRef(child)) {
          const dereferenced = expandRef(
            child,
            joinPointer(pathFromRoot, [key]),
          );
          circular = dereferenced.circular;
          if (node[key] !== dereferenced.value) node[key] = dereferenced.value;
        } else if (isWalkable(child) && parents.has(child)) {
          circular = true;
        } else {
          const dereferenced = crawl(
            child,
            joinPointer(path, [key]),
            joinPointer(pathFromRoot, [key]),
          );
          circular = dereferenced.circular;
          if (node[key] !== dereferenced.value) node[key] = dereferenced.value;
        }
        result.circular = result.circular || circular;
      }
    }

    parents.delete(node);
    return result;
  }

  return crawl(document, "#", "#").value as T;
}
