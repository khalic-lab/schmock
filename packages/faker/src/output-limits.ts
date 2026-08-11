import { ResourceLimitError } from "@schmock/core";
import {
  MAX_ARRAY_SIZE,
  MAX_GENERATED_NODES,
  MAX_OBJECT_PROPERTIES,
  MAX_STRING_LENGTH,
} from "./constants.js";

/** Enforce limits against the value that will actually leave the plugin. */
export function assertOutputWithinLimits(value: unknown): void {
  const pending: Array<{ value: unknown; exiting: boolean }> = [
    { value, exiting: false },
  ];
  const active = new Set<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;
    const current = frame.value;
    if (frame.exiting) {
      if (typeof current === "object" && current !== null) {
        active.delete(current);
      }
      continue;
    }

    nodes += 1;
    if (nodes > MAX_GENERATED_NODES) {
      throw new ResourceLimitError(
        "generated_nodes",
        MAX_GENERATED_NODES,
        nodes,
      );
    }

    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH) {
        throw new ResourceLimitError(
          "string_length",
          MAX_STRING_LENGTH,
          current.length,
        );
      }
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      active.has(current)
    ) {
      continue;
    }
    active.add(current);
    pending.push({ value: current, exiting: true });

    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_SIZE) {
        throw new ResourceLimitError(
          "array_size",
          MAX_ARRAY_SIZE,
          current.length,
        );
      }
      for (let index = 0; index < current.length; index += 1) {
        pending.push({ value: current[index], exiting: false });
      }
      continue;
    }

    const entries = Object.entries(current);
    if (entries.length > MAX_OBJECT_PROPERTIES) {
      throw new ResourceLimitError(
        "object_properties",
        MAX_OBJECT_PROPERTIES,
        entries.length,
      );
    }
    for (const [, entry] of entries) {
      pending.push({ value: entry, exiting: false });
    }
  }
}
