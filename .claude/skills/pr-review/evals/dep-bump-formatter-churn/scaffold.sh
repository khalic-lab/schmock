set -euo pipefail

git init -q -b main .
git config user.email "eval@example.com"
git config user.name "Eval"
git config commit.gpgsign false

mkdir -p src tools

# --- formatter v1: identity (the version before the bump) ---
cat > tools/format.sh <<'FMT'
#!/usr/bin/env bash
# Project formatter v1. Source on stdin, formatted source on stdout.
cat
FMT
chmod +x tools/format.sh

cat > src/deref.ts <<'TS'
/**
 * Resolve every internal $ref in a document.
 *
 * This is a deliberate re-implementation of the upstream resolver's
 * behaviour, not an improvement on it. parity.test.ts runs the same
 * documents through both and asserts the results are indistinguishable,
 * so a divergence fails the build.
 */
interface Resolved {
    value: unknown;
    circular: boolean;
}

function isWalkable(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isRef(value: unknown): value is { $ref: string } {
    return (
        isWalkable(value) &&
        "$ref" in value &&
        typeof value.$ref === "string" &&
        value.$ref.length > 0
    );
}

export function dereference<T>(document: T): T {
    const parents = new Set<object>();

    function walk(node: unknown, path: string): Resolved {
        const result: Resolved = { value: node, circular: false };
        if (!isWalkable(node)) {
            return result;
        }
        parents.add(node);
        if (isRef(node)) {
            const target = resolvePointer(document, node.$ref);
            result.value = walk(target, node.$ref).value;
        } else {
            for (const key of Object.keys(node)) {
                const child = node[key];
                if (isWalkable(child) && parents.has(child)) {
                    result.circular = true;
                    continue;
                }
                const resolved = walk(child, `${path}/${key}`);
                if (node[key] !== resolved.value) {
                    node[key] = resolved.value;
                }
            }
        }
        parents.delete(node);
        return result;
    }

    return walk(document, "#").value as T;
}

function resolvePointer(document: unknown, pointer: string): unknown {
    const tokens = pointer.replace(/^#\//, "").split("/");
    let cursor: unknown = document;
    for (const token of tokens) {
        if (!isWalkable(cursor)) {
            return undefined;
        }
        cursor = cursor[token];
    }
    return cursor;
}
TS

cat > src/normalize.ts <<'TS'
export interface NormalizedResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
}

const BODYLESS = new Set([204, 205, 304]);

export function normalize(
    status: number,
    body: unknown,
    headers: Record<string, string>,
): NormalizedResponse {
    if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new Error(`invalid status ${status}`);
    }
    if (BODYLESS.has(status)) {
        return {
            status,
            body: undefined,
            headers,
        };
    }
    return {
        status,
        body,
        headers,
    };
}

export function mergeHeaders(
    base: Record<string, string>,
    extra: Record<string, string>,
): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        merged[key.toLowerCase()] = value;
    }
    for (const [key, value] of Object.entries(extra)) {
        merged[key.toLowerCase()] = value;
    }
    return merged;
}
TS

cat > src/router.ts <<'TS'
export interface Route {
    method: string;
    pattern: string;
    params: string[];
}

export function compile(method: string, pattern: string): Route {
    const params: string[] = [];
    const segments = pattern.split("/");
    for (const segment of segments) {
        if (segment.startsWith(":")) {
            params.push(segment.slice(1));
        }
    }
    return {
        method: method.toUpperCase(),
        pattern,
        params,
    };
}

export function match(route: Route, method: string, path: string): boolean {
    if (route.method !== method.toUpperCase()) {
        return false;
    }
    const expected = route.pattern.split("/");
    const actual = path.split("/");
    if (expected.length !== actual.length) {
        return false;
    }
    for (let i = 0; i < expected.length; i++) {
        if (expected[i].startsWith(":")) {
            continue;
        }
        if (expected[i] !== actual[i]) {
            return false;
        }
    }
    return true;
}
TS

cat > src/validate.ts <<'TS'
export interface Issue {
    path: string;
    message: string;
}

export function validateRequired(
    value: Record<string, unknown>,
    required: string[],
): Issue[] {
    const issues: Issue[] = [];
    for (const key of required) {
        if (!(key in value)) {
            issues.push({
                path: key,
                message: `missing required property "${key}"`,
            });
        }
    }
    return issues;
}

export function validateTypes(
    value: Record<string, unknown>,
    types: Record<string, string>,
): Issue[] {
    const issues: Issue[] = [];
    for (const [key, expected] of Object.entries(types)) {
        if (!(key in value)) {
            continue;
        }
        const actual = typeof value[key];
        if (actual !== expected) {
            issues.push({
                path: key,
                message: `expected ${expected}, received ${actual}`,
            });
        }
    }
    return issues;
}
TS

cat > src/cache.ts <<'TS'
export class BoundedCache<K, V> {
    private readonly entries = new Map<K, V>();

    constructor(private readonly limit: number) {
        if (limit < 1) {
            throw new Error("limit must be at least 1");
        }
    }

    get(key: K): V | undefined {
        return this.entries.get(key);
    }

    set(key: K, value: V): void {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }
        this.entries.set(key, value);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
TS

cat > src/parity.test.ts <<'TS'
import { dereference } from "./deref.ts";

/**
 * Parity corpus. Each document is resolved by dereference() and compared
 * against the expected fully-resolved form.
 */
const CORPUS: Array<[string, unknown, unknown]> = [
    [
        "nested $ref",
        { paths: { user: { $ref: "#/definitions/User" } }, definitions: { User: { type: "object" } } },
        { paths: { user: { type: "object" } }, definitions: { User: { type: "object" } } },
    ],
    [
        "chained $ref",
        { a: { $ref: "#/b" }, b: { $ref: "#/c" }, c: { done: true } },
        { a: { done: true }, b: { done: true }, c: { done: true } },
    ],
    [
        "no refs at all",
        { openapi: "3.0.0", paths: {} },
        { openapi: "3.0.0", paths: {} },
    ],
];

export function runParity(): string[] {
    const failures: string[] = [];
    for (const [name, input, expected] of CORPUS) {
        const actual = dereference(structuredClone(input));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            failures.push(name);
        }
    }
    return failures;
}
TS

git add -A
git commit -q -m "initial import"

# --- the bump: formatter v2 reflows every file (indent 4 -> 2) ---
cat > tools/format.sh <<'FMT'
#!/usr/bin/env bash
# Project formatter v2. Source on stdin, formatted source on stdout.
# v2 narrowed the indent width from 4 spaces to 2.
perl -pe 's{^((?:    )+)}{"  " x (length($1) / 4)}e'
FMT
chmod +x tools/format.sh

for f in src/*.ts; do
    ./tools/format.sh < "$f" > "$f.fmt"
    mv "$f.fmt" "$f"
done

# ...and one edit that is not the formatter's, riding along in the churn.
perl -0pi -e 's{  return walk\(document, "#"\)\.value as T;}{  walk\(document, "#"\);\n  return document;}' src/deref.ts

git add -A
git commit -q -m "chore(deps): upgrade formatter to 2.0 (indent 4 -> 2)"
