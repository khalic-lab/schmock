import type { CodeOptions } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/*
 * The one AJV setup every spec schema is compiled with: request and response
 * validation (request-pipeline.ts) and the check of which examples a schema
 * accepts (example-values.ts). A leaf on purpose: it imports nothing from
 * the package, so the normalizer can use it without reaching the pipeline.
 */

/**
 * Decimal places of tolerance AJV allows when it divides a value by
 * `multipleOf`. Without one, 19.99 / 0.01 comes out as 1998.9999999999998 and
 * an exact amount of cents fails `multipleOf: 0.01`. The quotient's rounding
 * error grows with the value, so a tighter tolerance rejects large amounts
 * again: 1e-9 already refuses 1234567.89, while 1e-6 holds for cent values
 * past a hundred million.
 */
const MULTIPLE_OF_PRECISION = 6;

/**
 * Compiles a spec `pattern` the way faker's `compilePattern` does: with the
 * `u` flag first, then without it for patterns only the legacy grammar
 * accepts. AJV's default engine is `u`-only, so a pattern such as
 * `^\d{3}\-\d{4}$` (an identity escape `u` forbids) failed to compile while
 * faker generated values from it. A pattern neither grammar accepts still
 * throws.
 */
const specPatternEngine: NonNullable<CodeOptions["regExp"]> = Object.assign(
  (pattern: string, flags: string): RegExp => {
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      if (!flags.includes("u")) throw error;
      return new RegExp(pattern, flags.replace("u", ""));
    }
  },
  // Read only when AJV emits standalone source, which this package never does.
  { code: "specPatternEngine" },
);

/**
 * A draft 2020-12 AJV instance with the spec setup and `ajv-formats`.
 * `allErrors` is the one option its callers choose: validation reports every
 * error, the example check needs only a verdict.
 */
export function createSpecAjv(options: { allErrors?: boolean } = {}): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: options.allErrors ?? false,
    strictSchema: false,
    strictTypes: false,
    multipleOfPrecision: MULTIPLE_OF_PRECISION,
    code: { regExp: specPatternEngine },
    // With strictSchema off AJV ignores an unknown format such as Stripe's
    // `unix-time` or Train Travel's `iso-country-code`, but logs two console
    // lines per occurrence on every compile: tens of thousands for one large
    // response schema, with no option to silence them. Its other warnings are
    // strict-mode remarks on the spec's own schemas, which the mock's user
    // cannot act on either.
    logger: false,
  });
  addFormats(ajv);
  return ajv;
}
