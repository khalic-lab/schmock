/// <reference path="../../../types/schmock.d.ts" />

export interface PreferDirectives {
  code?: number;
  example?: string;
  dynamic?: boolean;
}

/**
 * Parse the RFC 7240 Prefer header for mock-specific directives.
 * Supports: code=N, example=name, dynamic=true
 */
export function parsePreferHeader(value: string): PreferDirectives {
  const result: PreferDirectives = {};

  for (const part of value.split(",")) {
    const trimmed = part.trim();

    const codeMatch = trimmed.match(/^code\s*=\s*(\d+)$/);
    if (codeMatch) {
      result.code = Number(codeMatch[1]);
      continue;
    }

    const exampleMatch = trimmed.match(/^example\s*=\s*(.+)$/);
    if (exampleMatch) {
      result.example = exampleMatch[1].trim();
      continue;
    }

    if (trimmed === "dynamic=true" || trimmed === "dynamic") {
      result.dynamic = true;
    }
  }

  return result;
}
