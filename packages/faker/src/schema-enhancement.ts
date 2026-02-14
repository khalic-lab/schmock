import type { JSONSchema7 } from "json-schema";
import { isJSONSchema7, validateFakerMethod } from "./validation.js";

/** JSONSchema7 extended with json-schema-faker's `faker` property */
interface FakerSchema extends JSONSchema7 {
  faker?: string;
}

export function enhanceSchemaWithSmartMapping(
  schema: JSONSchema7,
): JSONSchema7 {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const enhanced = { ...schema };

  // Handle object properties
  if (enhanced.type === "object" && enhanced.properties) {
    enhanced.properties = { ...enhanced.properties };

    for (const [fieldName, fieldSchema] of Object.entries(
      enhanced.properties,
    )) {
      if (isJSONSchema7(fieldSchema)) {
        enhanced.properties[fieldName] = enhanceFieldSchema(
          fieldName,
          fieldSchema,
        );
      }
    }
  }

  return enhanced;
}

function enhanceFieldSchema(
  fieldName: string,
  fieldSchema: JSONSchema7,
): FakerSchema {
  const enhanced: FakerSchema = { ...fieldSchema };

  // If already has faker extension, validate it and don't override
  if (enhanced.faker) {
    validateFakerMethod(enhanced.faker);
    return enhanced;
  }

  // Apply smart field name mapping
  const lowerFieldName = fieldName.toLowerCase();

  // Email fields
  if (lowerFieldName.includes("email")) {
    enhanced.format = "email";
    enhanced.faker = "internet.email";
  }
  // Name fields
  else if (lowerFieldName === "firstname" || lowerFieldName === "first_name") {
    enhanced.faker = "person.firstName";
  } else if (lowerFieldName === "lastname" || lowerFieldName === "last_name") {
    enhanced.faker = "person.lastName";
  } else if (lowerFieldName === "name" || lowerFieldName === "fullname") {
    enhanced.faker = "person.fullName";
  }
  // Phone fields
  else if (lowerFieldName.includes("phone") || lowerFieldName === "mobile") {
    enhanced.faker = "phone.number";
  }
  // Address fields
  else if (lowerFieldName === "street" || lowerFieldName === "address") {
    enhanced.faker = "location.streetAddress";
  } else if (lowerFieldName === "city") {
    enhanced.faker = "location.city";
  } else if (lowerFieldName === "zipcode" || lowerFieldName === "zip") {
    enhanced.faker = "location.zipCode";
  }
  // UUID fields
  else if (
    lowerFieldName === "uuid" ||
    (lowerFieldName === "id" && enhanced.format === "uuid")
  ) {
    enhanced.faker = "string.uuid";
  }
  // Date fields
  else if (
    lowerFieldName.includes("createdat") ||
    lowerFieldName.includes("created_at") ||
    lowerFieldName.includes("updatedat") ||
    lowerFieldName.includes("updated_at")
  ) {
    enhanced.format = "date-time";
    enhanced.faker = "date.recent";
  }
  // Company fields
  else if (lowerFieldName.includes("company")) {
    enhanced.faker = "company.name";
  } else if (lowerFieldName === "position" || lowerFieldName === "jobtitle") {
    enhanced.faker = "person.jobTitle";
  }
  // Price/money fields
  else if (lowerFieldName === "price" || lowerFieldName === "amount") {
    enhanced.faker = "commerce.price";
  }

  return enhanced;
}
