import { base, en, Faker } from "@faker-js/faker";
import type { JSONSchema7 } from "json-schema";
import { generate } from "json-schema-faker";

/**
 * Create isolated faker instance to avoid race conditions.
 * Each generation gets its own faker instance to ensure thread-safety.
 */
export function createFakerInstance(seed?: number) {
  const faker = new Faker({ locale: [en, base] });
  if (seed !== undefined) {
    faker.seed(seed);
  }
  return faker;
}

/**
 * Generate data from a JSON schema using json-schema-faker 0.6.0 async API.
 * Stateless — each call is self-contained with its own faker instance and options.
 */
export async function generateWithJsf(
  schema: JSONSchema7,
  seed?: number,
): Promise<unknown> {
  // When no seed is specified, generate a random seed to ensure different
  // results on each call. JSF 0.6.0 treats seed=undefined as deterministic.
  const effectiveSeed = seed ?? Math.floor(Math.random() * 2147483647);

  return generate(
    schema as any,
    {
      seed: effectiveSeed,
      optionalsProbability: 1.0,
      alwaysFakeOptionals: true,
      useDefaultValue: true,
      ignoreMissingRefs: true,
      failOnInvalidTypes: false,
      failOnInvalidFormat: false,
      extensions: { faker: createFakerInstance(seed) },
    } as any,
  );
}
