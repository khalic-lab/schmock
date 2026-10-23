import { capped } from "./saturating.js";

interface LengthBounds {
  min: number;
  max: number;
}

interface RegexFrame extends LengthBounds {
  alternatives: LengthBounds[];
  zeroWidth: boolean;
}

const EMPTY: LengthBounds = { min: 0, max: 0 };
const SINGLE: LengthBounds = { min: 1, max: 1 };

/**
 * Length bounds of the strings a regular expression describes, from the
 * repetition it states explicitly. `min` is the shortest match; `max` charges
 * each quantifier's upper bound, and only the lower bound of an unbounded one
 * (`*`, `+`, `{n,}`), since generators cap open repetition themselves. Anchors
 * and lookarounds are zero-width and a backreference counts as empty, so `min`
 * never overstates what a generator must produce.
 */
export function regexLengthBounds(pattern: string): LengthBounds {
  const frames: RegexFrame[] = [newRegexFrame(false)];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    const frame = frames[frames.length - 1];
    if (char === "|") {
      frame.alternatives.push({ min: frame.min, max: frame.max });
      frame.min = 0;
      frame.max = 0;
      index += 1;
      continue;
    }
    if (char === "(") {
      const prefix = regexGroupPrefix(pattern, index);
      frames.push(newRegexFrame(prefix.zeroWidth));
      index += prefix.length;
      continue;
    }

    let atom: LengthBounds;
    if (char === ")") {
      const group = frames.length > 1 ? frames.pop() : undefined;
      atom = group ? closeRegexFrame(group) : SINGLE;
      index += 1;
    } else if (char === "[") {
      index = skipRegexClass(pattern, index);
      atom = SINGLE;
    } else if (char === "\\") {
      const escaped = readRegexEscape(pattern, index);
      index = escaped.next;
      atom = escaped.width;
    } else if (char === "^" || char === "$") {
      index += 1;
      atom = EMPTY;
    } else {
      index += 1;
      atom = SINGLE;
    }

    const quantifier = readRegexQuantifier(pattern, index);
    if (quantifier) {
      index = quantifier.next;
      atom = {
        min: multiplied(atom.min, quantifier.min),
        max: multiplied(atom.max, quantifier.max),
      };
    }
    const current = frames[frames.length - 1];
    current.min = capped(current.min + atom.min);
    current.max = capped(current.max + atom.max);
  }

  while (frames.length > 1) {
    const group = frames.pop();
    if (!group) break;
    const bounds = closeRegexFrame(group);
    const parent = frames[frames.length - 1];
    parent.min = capped(parent.min + bounds.min);
    parent.max = capped(parent.max + bounds.max);
  }
  return closeRegexFrame(frames[0]);
}

function newRegexFrame(zeroWidth: boolean): RegexFrame {
  return { min: 0, max: 0, alternatives: [], zeroWidth };
}

function closeRegexFrame(frame: RegexFrame): LengthBounds {
  if (frame.zeroWidth) return EMPTY;
  let min = frame.min;
  let max = frame.max;
  for (const alternative of frame.alternatives) {
    min = Math.min(min, alternative.min);
    max = Math.max(max, alternative.max);
  }
  return { min, max };
}

function regexGroupPrefix(
  pattern: string,
  index: number,
): { length: number; zeroWidth: boolean } {
  for (const lookaround of ["(?<=", "(?<!", "(?=", "(?!"]) {
    if (pattern.startsWith(lookaround, index)) {
      return { length: lookaround.length, zeroWidth: true };
    }
  }
  if (pattern.startsWith("(?<", index)) {
    const end = pattern.indexOf(">", index);
    return { length: end === -1 ? 3 : end - index + 1, zeroWidth: false };
  }
  if (pattern.startsWith("(?:", index)) return { length: 3, zeroWidth: false };
  return { length: 1, zeroWidth: false };
}

function skipRegexClass(pattern: string, index: number): number {
  let cursor = index + 1;
  while (cursor < pattern.length) {
    if (pattern[cursor] === "\\") {
      cursor += 2;
    } else if (pattern[cursor] === "]") {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return pattern.length;
}

function readRegexEscape(
  pattern: string,
  index: number,
): { next: number; width: LengthBounds } {
  const escaped = pattern[index + 1];
  const skipTo = (terminator: string, fallback: number): number => {
    const end = pattern.indexOf(terminator, index + 2);
    return end === -1 ? fallback : end + 1;
  };
  switch (escaped) {
    case undefined:
      return { next: index + 1, width: SINGLE };
    case "b":
    case "B":
      return { next: index + 2, width: EMPTY };
    case "k":
      return pattern[index + 2] === "<"
        ? { next: skipTo(">", index + 2), width: EMPTY }
        : { next: index + 2, width: SINGLE };
    case "u":
      return pattern[index + 2] === "{"
        ? { next: skipTo("}", index + 2), width: SINGLE }
        : { next: index + 6, width: SINGLE };
    case "x":
      return { next: index + 4, width: SINGLE };
    case "c":
      return { next: index + 3, width: SINGLE };
    case "p":
    case "P":
      return pattern[index + 2] === "{"
        ? { next: skipTo("}", index + 2), width: SINGLE }
        : { next: index + 2, width: SINGLE };
    default:
      if (escaped >= "1" && escaped <= "9") {
        let next = index + 2;
        while (next < pattern.length && /\d/.test(pattern[next])) next += 1;
        return { next, width: EMPTY };
      }
      return { next: index + 2, width: SINGLE };
  }
}

function readRegexQuantifier(
  pattern: string,
  index: number,
): { min: number; max: number; next: number } | undefined {
  const char = pattern[index];
  let quantifier: { min: number; max: number; next: number } | undefined;
  if (char === "*") quantifier = { min: 0, max: 0, next: index + 1 };
  else if (char === "+") quantifier = { min: 1, max: 1, next: index + 1 };
  else if (char === "?") quantifier = { min: 0, max: 1, next: index + 1 };
  else if (char === "{") {
    const counted = /\{(\d+)(,(\d*))?\}/y;
    counted.lastIndex = index;
    const match = counted.exec(pattern);
    if (match) {
      const min = Number(match[1]);
      const max =
        match[2] === undefined || match[3] === "" ? min : Number(match[3]);
      quantifier = {
        min,
        max: Math.max(min, max),
        next: index + match[0].length,
      };
    }
  }
  // A trailing `?` makes the quantifier lazy without changing its bounds.
  if (quantifier && pattern[quantifier.next] === "?") quantifier.next += 1;
  return quantifier;
}

function multiplied(left: number, right: number): number {
  return left === 0 || right === 0 ? 0 : capped(left * right);
}
