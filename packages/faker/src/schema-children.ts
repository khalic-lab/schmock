import type { JSONSchema7 } from "json-schema";

export interface SchemaChild {
  schema: JSONSchema7;
  path: string;
  depthCost: 0 | 1;
  frameCost: 0 | 1;
  typedContinuation: boolean;
}

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
  const add = (
    value: unknown,
    childPath: string,
    depthCost: 0 | 1,
    frameCost: 0 | 1,
    typedContinuation = false,
  ): void => {
    if (isSchema(value)) {
      children.push({
        schema: value,
        path: childPath,
        depthCost,
        frameCost,
        typedContinuation,
      });
    }
  };
  const hasType = (type: "array" | "object"): boolean =>
    schema.type === type ||
    (Array.isArray(schema.type) && schema.type.includes(type));

  if (Array.isArray(schema.items)) {
    schema.items.forEach((item, index) => {
      add(item, `${path}.items[${index}]`, 1, 0, hasType("array"));
    });
  } else {
    add(schema.items, `${path}.items`, 1, 0, hasType("array"));
  }

  const prefixItems = Reflect.get(schema, "prefixItems");
  if (Array.isArray(prefixItems)) {
    prefixItems.forEach((item, index) => {
      add(item, `${path}.prefixItems[${index}]`, 1, 0, hasType("array"));
    });
  }

  add(schema.additionalItems, `${path}.additionalItems`, 1, 0);
  add(schema.contains, `${path}.contains`, 1, 0);
  const containsAll = Reflect.get(schema, "containsAll");
  if (Array.isArray(containsAll)) {
    containsAll.forEach((item, index) => {
      add(item, `${path}.containsAll[${index}]`, 1, 0);
    });
  }

  for (const [keyword, values] of [
    ["properties", schema.properties],
    ["patternProperties", schema.patternProperties],
  ] as const) {
    if (!values) continue;
    for (const [name, value] of Object.entries(values)) {
      add(
        value,
        `${path}.${keyword}.${name}`,
        1,
        0,
        keyword === "properties" && hasType("object"),
      );
    }
  }
  add(schema.additionalProperties, `${path}.additionalProperties`, 1, 0);
  add(schema.propertyNames, `${path}.propertyNames`, 1, 0);

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    schema[keyword]?.forEach((branch, index) => {
      add(branch, `${path}.${keyword}[${index}]`, 0, 1);
    });
  }
  for (const keyword of ["not", "if", "then", "else"] as const) {
    add(schema[keyword], `${path}.${keyword}`, 0, 1);
  }

  for (const keyword of ["definitions", "$defs"] as const) {
    const definitions = Reflect.get(schema, keyword);
    if (!isRecord(definitions)) continue;
    for (const [name, definition] of Object.entries(definitions)) {
      add(definition, `${path}.${keyword}.${name}`, 0, 1);
    }
  }

  if (schema.dependencies) {
    for (const [name, dependency] of Object.entries(schema.dependencies)) {
      if (!Array.isArray(dependency)) {
        add(dependency, `${path}.dependencies.${name}`, 0, 1);
      }
    }
  }

  const dependentSchemas = Reflect.get(schema, "dependentSchemas");
  if (isRecord(dependentSchemas)) {
    for (const [name, definition] of Object.entries(dependentSchemas)) {
      add(definition, `${path}.dependentSchemas.${name}`, 0, 1);
    }
  }
  add(Reflect.get(schema, "contentSchema"), `${path}.contentSchema`, 0, 1);

  return children;
}
