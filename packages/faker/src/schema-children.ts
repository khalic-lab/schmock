import type { JSONSchema7 } from "json-schema";

export interface SchemaChild {
  schema: JSONSchema7;
  path: string;
  depthCost: 0 | 1;
  frameCost: 0 | 1;
  typedContinuation: boolean;
  /**
   * False for keywords whose subschema never produces a value of its own:
   * `not` and `if` only test the value, and `definitions`/`$defs` are reached
   * for generation only through a `$ref`. Resource limits are charged along
   * generating edges only.
   */
  generates: boolean;
}

interface ChildCost {
  depthCost: 0 | 1;
  frameCost: 0 | 1;
  typedContinuation?: boolean;
  generates?: boolean;
}

/** A child one value level down (a property, an item). */
const VALUE_LEVEL: ChildCost = { depthCost: 1, frameCost: 0 };
/** A child describing the same value (composition, conditionals). */
const SAME_LEVEL: ChildCost = { depthCost: 0, frameCost: 1 };
/** A same-level child that never generates a value of its own. */
const NON_GENERATING: ChildCost = { ...SAME_LEVEL, generates: false };

function isSchema(value: unknown): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enumerate every schema-bearing keyword forwarded to json-schema-faker.
 * Validation, reference indexing, and path analysis all consume this one list.
 */
export function collectSchemaChildren(
  schema: JSONSchema7,
  path: string,
): SchemaChild[] {
  const children: SchemaChild[] = [];
  const add = (value: unknown, childPath: string, cost: ChildCost): void => {
    if (isSchema(value)) {
      children.push({
        schema: value,
        path: childPath,
        depthCost: cost.depthCost,
        frameCost: cost.frameCost,
        typedContinuation: cost.typedContinuation ?? false,
        generates: cost.generates ?? true,
      });
    }
  };
  const hasType = (type: "array" | "object"): boolean =>
    schema.type === type ||
    (Array.isArray(schema.type) && schema.type.includes(type));

  if (Array.isArray(schema.items)) {
    schema.items.forEach((item, index) => {
      add(item, `${path}.items[${index}]`, {
        ...VALUE_LEVEL,
        typedContinuation: hasType("array"),
      });
    });
  } else {
    add(schema.items, `${path}.items`, {
      ...VALUE_LEVEL,
      typedContinuation: hasType("array"),
    });
  }

  const prefixItems = Reflect.get(schema, "prefixItems");
  if (Array.isArray(prefixItems)) {
    prefixItems.forEach((item, index) => {
      add(item, `${path}.prefixItems[${index}]`, {
        ...VALUE_LEVEL,
        typedContinuation: hasType("array"),
      });
    });
  }

  add(schema.additionalItems, `${path}.additionalItems`, VALUE_LEVEL);
  add(schema.contains, `${path}.contains`, VALUE_LEVEL);
  const containsAll = Reflect.get(schema, "containsAll");
  if (Array.isArray(containsAll)) {
    containsAll.forEach((item, index) => {
      add(item, `${path}.containsAll[${index}]`, VALUE_LEVEL);
    });
  }

  for (const [keyword, values] of [
    ["properties", schema.properties],
    ["patternProperties", schema.patternProperties],
  ] as const) {
    if (!values) continue;
    for (const [name, value] of Object.entries(values)) {
      add(value, `${path}.${keyword}.${name}`, {
        ...VALUE_LEVEL,
        typedContinuation: keyword === "properties" && hasType("object"),
      });
    }
  }
  add(schema.additionalProperties, `${path}.additionalProperties`, VALUE_LEVEL);
  add(schema.propertyNames, `${path}.propertyNames`, VALUE_LEVEL);

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    schema[keyword]?.forEach((branch, index) => {
      add(branch, `${path}.${keyword}[${index}]`, SAME_LEVEL);
    });
  }
  for (const keyword of ["not", "if"] as const) {
    add(schema[keyword], `${path}.${keyword}`, NON_GENERATING);
  }
  for (const keyword of ["then", "else"] as const) {
    add(schema[keyword], `${path}.${keyword}`, SAME_LEVEL);
  }

  for (const keyword of ["definitions", "$defs"] as const) {
    const definitions = Reflect.get(schema, keyword);
    if (!isRecord(definitions)) continue;
    for (const [name, definition] of Object.entries(definitions)) {
      add(definition, `${path}.${keyword}.${name}`, NON_GENERATING);
    }
  }

  if (schema.dependencies) {
    for (const [name, dependency] of Object.entries(schema.dependencies)) {
      if (!Array.isArray(dependency)) {
        add(dependency, `${path}.dependencies.${name}`, SAME_LEVEL);
      }
    }
  }

  const dependentSchemas = Reflect.get(schema, "dependentSchemas");
  if (isRecord(dependentSchemas)) {
    for (const [name, definition] of Object.entries(dependentSchemas)) {
      add(definition, `${path}.dependentSchemas.${name}`, SAME_LEVEL);
    }
  }
  add(
    Reflect.get(schema, "contentSchema"),
    `${path}.contentSchema`,
    SAME_LEVEL,
  );

  return children;
}
