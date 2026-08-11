interface ParsedMediaType {
  type: string;
  subtype: string;
  parameters: Map<string, string>;
}

interface AcceptRange extends ParsedMediaType {
  q: number;
}

interface MatchSpecificity {
  /** 3 exact, 2 type wildcard, 1 full wildcard. */
  mediaRange: number;
  /** More matching media parameters take precedence within one range. */
  parameters: number;
}

/** The declared OpenAPI key and the concrete media type to put on the wire. */
export interface ContentTypeMatch {
  declared: string;
  contentType: string;
}

/** Split a header list without treating delimiters inside quoted strings as syntax. */
function splitOutsideQuotes(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function parameterValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !trimmed.startsWith('"') ||
    !trimmed.endsWith('"')
  ) {
    return trimmed;
  }

  let result = "";
  for (let index = 1; index < trimmed.length - 1; index++) {
    const character = trimmed[index];
    if (character === "\\" && index + 1 < trimmed.length - 1) {
      index++;
      result += trimmed[index];
    } else {
      result += character;
    }
  }
  return result;
}

function parseParameter(part: string): [string, string] | undefined {
  const equals = part.indexOf("=");
  if (equals < 1) return undefined;
  const name = part.slice(0, equals).trim().toLowerCase();
  if (!name) return undefined;
  return [name, parameterValue(part.slice(equals + 1))];
}

function parseTypeAndSubtype(
  value: string,
): Pick<ParsedMediaType, "type" | "subtype"> | null {
  const slash = value.indexOf("/");
  if (slash < 1 || value.indexOf("/", slash + 1) !== -1) return null;
  const type = value.slice(0, slash).trim().toLowerCase();
  const subtype = value
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  return type && subtype ? { type, subtype } : null;
}

function parseMediaType(value: string): ParsedMediaType | null {
  const [mediaType, ...parameterParts] = splitOutsideQuotes(value, ";");
  const parsed = parseTypeAndSubtype(mediaType);
  if (!parsed) return null;

  const parameters = new Map<string, string>();
  for (const part of parameterParts) {
    const parameter = parseParameter(part);
    if (parameter) parameters.set(...parameter);
  }
  return { ...parsed, parameters };
}

function parseQuality(value: string): number {
  if (!value) return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}

function parseAcceptRange(value: string): AcceptRange | null {
  const [mediaType, ...parameterParts] = splitOutsideQuotes(value, ";");
  const parsed = parseTypeAndSubtype(mediaType);
  if (!parsed) return null;

  const parameters = new Map<string, string>();
  let q = 1;
  for (const part of parameterParts) {
    const parameter = parseParameter(part);
    if (!parameter) continue;
    const [name, rawValue] = parameter;
    if (name === "q") {
      q = parseQuality(rawValue);
    } else {
      parameters.set(name, rawValue);
    }
  }

  return { ...parsed, parameters, q };
}

function parseAcceptRanges(accept: string): AcceptRange[] {
  const ranges: AcceptRange[] = [];
  for (const part of splitOutsideQuotes(accept, ",")) {
    const range = parseAcceptRange(part.trim());
    if (range) ranges.push(range);
  }
  return ranges;
}

function parameterValuesEqual(
  name: string,
  left: string,
  right: string,
): boolean {
  return name === "charset"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function specificity(
  range: ParsedMediaType,
  mediaType: ParsedMediaType,
): MatchSpecificity | null {
  let mediaRange = 0;
  if (range.type === "*" && range.subtype === "*") {
    mediaRange = 1;
  } else if (range.type === mediaType.type && range.subtype === "*") {
    mediaRange = 2;
  } else if (
    range.type === mediaType.type &&
    range.subtype === mediaType.subtype
  ) {
    mediaRange = 3;
  } else {
    return null;
  }

  for (const [name, value] of range.parameters) {
    const candidate = mediaType.parameters.get(name);
    if (
      candidate === undefined ||
      !parameterValuesEqual(name, value, candidate)
    ) {
      return null;
    }
  }
  return { mediaRange, parameters: range.parameters.size };
}

function isMoreSpecific(
  candidate: MatchSpecificity,
  current: MatchSpecificity | null,
): boolean {
  if (!current) return true;
  if (candidate.mediaRange !== current.mediaRange) {
    return candidate.mediaRange > current.mediaRange;
  }
  return candidate.parameters > current.parameters;
}

function qualityFor(
  mediaType: ParsedMediaType,
  ranges: AcceptRange[],
): number | null {
  let matched: MatchSpecificity | null = null;
  let q = 0;
  for (const range of ranges) {
    const candidate = specificity(range, mediaType);
    // Equal specificity keeps the first field occurrence authoritative.
    if (candidate && isMoreSpecific(candidate, matched)) {
      matched = candidate;
      q = range.q;
    }
  }
  return matched ? q : null;
}

function isConcrete(mediaType: ParsedMediaType): boolean {
  return mediaType.type !== "*" && mediaType.subtype !== "*";
}

function mergeParameters(
  left: Map<string, string>,
  right: Map<string, string>,
): Map<string, string> | null {
  const merged = new Map(left);
  for (const [name, value] of right) {
    const existing = merged.get(name);
    if (
      existing !== undefined &&
      !parameterValuesEqual(name, existing, value)
    ) {
      return null;
    }
    if (existing === undefined) merged.set(name, value);
  }
  return merged;
}

function concreteIntersections(
  declared: ParsedMediaType,
  accepted: AcceptRange,
): ParsedMediaType[] {
  if (
    declared.type !== "*" &&
    accepted.type !== "*" &&
    declared.type !== accepted.type
  ) {
    return [];
  }
  if (
    declared.subtype !== "*" &&
    accepted.subtype !== "*" &&
    declared.subtype !== accepted.subtype
  ) {
    return [];
  }

  const type = declared.type === "*" ? accepted.type : declared.type;
  const subtype =
    declared.subtype === "*" ? accepted.subtype : declared.subtype;
  if (type === "*") return [];

  const parameters = mergeParameters(declared.parameters, accepted.parameters);
  if (!parameters) return [];
  const subtypes = subtype === "*" ? defaultSubtypes(type) : [subtype];
  return subtypes.map((concreteSubtype) => ({
    type,
    subtype: concreteSubtype,
    parameters,
  }));
}

function defaultSubtypes(type: string): string[] {
  switch (type) {
    case "application":
      return ["json", "octet-stream"];
    case "text":
      return ["plain"];
    case "image":
      return ["png"];
    case "audio":
      return ["mpeg"];
    case "video":
      return ["mp4"];
    default:
      return ["x-schmock"];
  }
}

function defaultCandidates(declared: ParsedMediaType): ParsedMediaType[] {
  if (isConcrete(declared)) return [declared];

  if (declared.type === "*") {
    return [
      { type: "application", subtype: "json", parameters: declared.parameters },
      {
        type: "application",
        subtype: "octet-stream",
        parameters: declared.parameters,
      },
      { type: "text", subtype: "plain", parameters: declared.parameters },
    ];
  }

  return defaultSubtypes(declared.type).map((subtype) => ({
    type: declared.type,
    subtype,
    parameters: declared.parameters,
  }));
}

function candidateKey(candidate: ParsedMediaType): string {
  return `${candidate.type}/${candidate.subtype};${[...candidate.parameters]
    .map(([name, value]) => `${name}=${value}`)
    .join(";")}`;
}

function candidatesFor(
  declared: ParsedMediaType,
  ranges: AcceptRange[],
): ParsedMediaType[] {
  if (isConcrete(declared)) return [declared];

  const candidates: ParsedMediaType[] = [];
  const seen = new Set<string>();
  const add = (candidate: ParsedMediaType | null): void => {
    if (!candidate) return;
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const range of ranges) {
    for (const candidate of concreteIntersections(declared, range)) {
      add(candidate);
    }
  }
  for (const candidate of defaultCandidates(declared)) add(candidate);
  return candidates;
}

const TOKEN_VALUE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function serializeMediaType(mediaType: ParsedMediaType): string {
  let value = `${mediaType.type}/${mediaType.subtype}`;
  for (const [name, parameter] of mediaType.parameters) {
    const serialized = TOKEN_VALUE.test(parameter)
      ? parameter
      : `"${parameter.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    value += `;${name}=${serialized}`;
  }
  return value;
}

interface DeclaredMediaType {
  raw: string;
  mediaType: ParsedMediaType;
  order: number;
}

interface CanonicalDeclaration extends DeclaredMediaType {
  specificity: MatchSpecificity;
}

function canonicalDeclaration(
  candidate: ParsedMediaType,
  declarations: DeclaredMediaType[],
): CanonicalDeclaration | null {
  let best: CanonicalDeclaration | null = null;
  for (const declaration of declarations) {
    const candidateSpecificity = specificity(declaration.mediaType, candidate);
    if (
      candidateSpecificity &&
      isMoreSpecific(candidateSpecificity, best?.specificity ?? null)
    ) {
      best = { ...declaration, specificity: candidateSpecificity };
    }
  }
  return best;
}

function equalSpecificity(
  left: MatchSpecificity,
  right: MatchSpecificity,
): boolean {
  return (
    left.mediaRange === right.mediaRange && left.parameters === right.parameters
  );
}

function equalParameters(
  left: Map<string, string>,
  right: Map<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other === undefined || !parameterValuesEqual(name, value, other)) {
      return false;
    }
  }
  return true;
}

function wireContentType(
  candidate: ParsedMediaType,
  declaration: DeclaredMediaType,
): string {
  return isConcrete(declaration.mediaType) &&
    equalParameters(candidate.parameters, declaration.mediaType.parameters)
    ? declaration.raw
    : serializeMediaType(candidate);
}

/**
 * Select both the raw OpenAPI content key and a concrete wire media type.
 * Declared wildcard ranges use a concrete type from Accept or a JSON-safe
 * default; concrete declarations retain their raw spelling and parameters.
 */
export function negotiateContentTypeMatch(
  accept: string,
  available: string[],
): ContentTypeMatch | null {
  const ranges = parseAcceptRanges(accept);
  const hasAccept = accept.trim().length > 0;
  const declarations: DeclaredMediaType[] = [];
  for (const [order, raw] of available.entries()) {
    const mediaType = parseMediaType(raw);
    if (mediaType) declarations.push({ raw, mediaType, order });
  }

  let best: {
    match: ContentTypeMatch;
    declaration: CanonicalDeclaration;
  } | null = null;
  let bestScore = 0;
  for (const source of declarations) {
    for (const candidate of candidatesFor(source.mediaType, ranges)) {
      const q = hasAccept ? qualityFor(candidate, ranges) : 1;
      if (q === null || q <= 0) continue;
      const declaration = canonicalDeclaration(candidate, declarations);
      if (!declaration) continue;

      const winsTie =
        best !== null &&
        (isMoreSpecific(
          declaration.specificity,
          best.declaration.specificity,
        ) ||
          (equalSpecificity(
            declaration.specificity,
            best.declaration.specificity,
          ) &&
            declaration.order < best.declaration.order));
      if (q > bestScore || (q === bestScore && winsTie)) {
        bestScore = q;
        best = {
          match: {
            declared: declaration.raw,
            contentType: wireContentType(candidate, declaration),
          },
          declaration,
        };
      }
    }
  }
  return best?.match ?? null;
}

/** Find the most specific declared key covering an explicit Content-Type. */
export function matchDeclaredContentType(
  contentType: string,
  available: string[],
): string | null {
  const parsed = parseMediaType(contentType);
  if (!parsed || !isConcrete(parsed)) return null;

  let best: string | null = null;
  let bestSpecificity: MatchSpecificity | null = null;
  for (const raw of available) {
    const declared = parseMediaType(raw);
    if (!declared) continue;
    const candidate = specificity(declared, parsed);
    if (candidate && isMoreSpecific(candidate, bestSpecificity)) {
      best = raw;
      bestSpecificity = candidate;
    }
  }
  return best;
}

/** Negotiate the concrete media type to place on the response. */
export function negotiateContentType(
  accept: string,
  available: string[],
): string | null {
  return negotiateContentTypeMatch(accept, available)?.contentType ?? null;
}
