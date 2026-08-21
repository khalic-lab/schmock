import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";

/**
 * The reported browser failure, as a consumer of the packed tarballs.
 *
 * An inline spec whose `$ref` points inside itself is the overwhelmingly common
 * shape and the one that used to drag `@apidevtools/swagger-parser` — and with
 * it `require("path")` and `require("util")` — into an application bundle.
 *
 * This module is bundled by `check-release-candidate.sh` with esbuild rather
 * than `bun build`: bun's browser target accepts an unresolvable CommonJS
 * `require` and rewrites it into a shim that throws only when called, so it
 * cannot see this class of defect at all.
 */

const mock = schmock({ state: {} });

mock.pipe(
  await openapi({
    spec: {
      openapi: "3.0.3",
      info: { title: "Release Candidate", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
        },
      },
    },
  }),
);

const { status, body } = await mock.handle("GET", "/pets");
if (status !== 200 || !Array.isArray(body)) {
  throw new Error(
    `OpenAPI plugin did not serve the inline spec in a browser bundle: ${status}`,
  );
}

export { mock };
