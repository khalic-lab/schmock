import { SchmockError } from "@schmock/core";

function describeReceived(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return "<unprintable>";
  }
}

/** The `DEVTOOLS_CONFIG_INVALID` error for one option of a devtools entry point. */
export function invalidOption(
  entryPoint: string,
  option: string,
  requirement: string,
  value: unknown,
): SchmockError {
  return new SchmockError(
    `${entryPoint}: ${option} must be ${requirement} (received ${describeReceived(value)})`,
    "DEVTOOLS_CONFIG_INVALID",
    { option, received: value },
  );
}
