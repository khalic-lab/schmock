import { en, Faker } from "@faker-js/faker";
import jsf from "json-schema-faker";

/**
 * Create isolated faker instance to avoid race conditions
 * Each generation gets its own faker instance to ensure thread-safety
 * @returns Fresh Faker instance with English locale
 */
export function createFakerInstance(seed?: number) {
  const faker = new Faker({ locale: [en] });
  if (seed !== undefined) {
    faker.seed(seed);
  }
  return faker;
}

let jsfConfigured = false;
let currentSeed: number | undefined;

/**
 * Create a seeded PRNG using the mulberry32 algorithm.
 * Returns a function that produces deterministic values in [0, 1).
 */
function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getJsf(seed?: number): typeof jsf {
  const seedChanged = seed !== currentSeed;
  if (!jsfConfigured || seedChanged) {
    currentSeed = seed;
    jsf.extend("faker", () => createFakerInstance(seed));
    jsf.option({
      requiredOnly: false,
      alwaysFakeOptionals: true,
      useDefaultValue: true,
      ignoreMissingRefs: true,
      failOnInvalidTypes: false,
      failOnInvalidFormat: false,
    });
    jsfConfigured = true;
  }
  // Always reset PRNG for deterministic output per call
  if (seed !== undefined) {
    jsf.option({ random: createSeededRandom(seed) });
    jsf.extend("faker", () => createFakerInstance(seed));
  }
  return jsf;
}
