import { schmock } from "../index";

/**
 * Evaluate docString code that declares `const mock = schmock(...)`.
 * Returns the mock instance for use in subsequent steps.
 */
export function evalMockSetup(
  code: string,
  deps: Record<string, unknown> = {},
): any {
  const allDeps = { schmock, ...deps };
  const params = Object.keys(allDeps);
  const fn = new Function(...params, `${code}\nreturn mock;`);
  return fn(...Object.values(allDeps));
}
