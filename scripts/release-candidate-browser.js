import { validationPlugin } from "@schmock/validation";

const plugin = validationPlugin({
  request: {
    body: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  },
});

if (plugin.name !== "validation") {
  throw new Error("Validation plugin could not initialize in a browser bundle");
}

export { plugin };
