/**
 * OpenAPI path templates (`/pets/{petId}`) → schmock route paths (`/pets/:petId`).
 *
 * Braces delimit an OpenAPI parameter unambiguously; core's route grammar does
 * not, so the conversion has to spell out what the braces implied:
 *
 * - a literal `:` becomes `\:`, so `{job}:cancel` is one parameter followed by
 *   the literal ":cancel" rather than two parameters;
 * - a name outside core's plain grammar, or one the following literal would
 *   run into, is quoted — `{user.id}` → `:"user.id"`, `{x}_{y}` → `:"x"_:y` —
 *   so the request's params are keyed by the spec's own name;
 * - templates core cannot express at all (two parameters with nothing between
 *   them, a quote inside a name, a backslash right before a parameter) are
 *   reported by {@link describePathTemplateProblem} so the operation can be
 *   skipped with a warning instead of compiling to a route that answers the
 *   wrong requests.
 */

type TemplatePart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "param"; readonly name: string };

export interface TemplateConversionOptions {
  /**
   * Escape literal colons as `\:`. The parser always does; a schema-override
   * key is also looked up unescaped, because an Express-form key
   * (`GET /pets/:petId`) runs through the same conversion.
   */
  escapeLiteralColons: boolean;
}

const TEMPLATE_PARAM = /\{([^}]+)\}/g;
const PLAIN_NAME = /^[A-Za-z0-9_-]+$/;
const PLAIN_NAME_START = /^[A-Za-z0-9_]/;
const HYPHENS_ONLY = /^-+$/;

function splitTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(TEMPLATE_PARAM)) {
    if (match.index > last) {
      parts.push({ kind: "literal", text: template.slice(last, match.index) });
    }
    parts.push({ kind: "param", name: match[1] });
    last = match.index + match[0].length;
  }
  if (last < template.length) {
    parts.push({ kind: "literal", text: template.slice(last) });
  }
  return parts;
}

/**
 * Whether `:name` followed by `after` reads back as exactly that parameter.
 * Core reads a plain name greedily over `[A-Za-z0-9_-]` and gives trailing
 * hyphens back only when another parameter follows them.
 */
function canWriteUnquoted(
  name: string,
  after: string,
  paramFollows: boolean,
): boolean {
  if (!PLAIN_NAME.test(name)) return false;
  if (PLAIN_NAME_START.test(after)) return false;
  if (!after.startsWith("-")) return true;
  return HYPHENS_ONLY.test(after) && paramFollows && !name.endsWith("-");
}

export function templateToRoutePath(
  template: string,
  options: TemplateConversionOptions,
): string {
  const parts = splitTemplate(template).map((part) =>
    part.kind === "literal" && options.escapeLiteralColons
      ? { ...part, text: part.text.replaceAll(":", "\\:") }
      : part,
  );

  return parts
    .map((part, index) => {
      if (part.kind === "literal") return part.text;
      const next = parts[index + 1];
      const after = next?.kind === "literal" ? next.text : "";
      const paramFollows = parts[index + 2]?.kind === "param";
      return canWriteUnquoted(part.name, after, paramFollows)
        ? `:${part.name}`
        : `:"${part.name}"`;
    })
    .join("");
}

/**
 * Why a template has no faithful route path, or undefined when it has one.
 */
export function describePathTemplateProblem(
  template: string,
): string | undefined {
  const parts = splitTemplate(template);
  for (const [index, part] of parts.entries()) {
    if (part.kind === "literal") continue;
    const previous = parts[index - 1];
    if (previous?.kind === "param") {
      return `path parameters {${previous.name}} and {${part.name}} are adjacent, so no request decides where one ends`;
    }
    if (previous?.kind === "literal" && previous.text.endsWith("\\")) {
      return `a backslash directly before {${part.name}} cannot be expressed as a route`;
    }
    if (part.name.includes('"')) {
      return `path parameter name {${part.name}} contains a double quote`;
    }
  }
  return undefined;
}

const PLAIN_PARAM_SEGMENT = /^:([A-Za-z0-9_-]+)$/;
const QUOTED_PARAM_SEGMENT = /^:"([^"]+)"$/;

/**
 * The parameter name of a path segment that is exactly one parameter
 * (`:petId`, `:"user.id"`), or undefined for anything else — including a
 * custom-method segment such as `:job\:cancel`.
 */
export function segmentParamName(segment: string): string | undefined {
  return (
    PLAIN_PARAM_SEGMENT.exec(segment)?.[1] ??
    QUOTED_PARAM_SEGMENT.exec(segment)?.[1]
  );
}
