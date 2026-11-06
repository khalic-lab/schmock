import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin.js";
import {
  collectionStateKey,
  counterStateKey,
  parentParamNames,
  scopeSuffix,
  seededStateKey,
} from "./state-keys.js";

describe("state-keys", () => {
  describe("parentParamNames", () => {
    it("returns no names for a flat collection", () => {
      expect(parentParamNames("/pets")).toEqual([]);
      expect(parentParamNames("/admins/users")).toEqual([]);
    });

    it("returns parent params in path order", () => {
      expect(parentParamNames("/owners/:ownerId/pets")).toEqual(["ownerId"]);
      expect(parentParamNames("/teams/:teamId/owners/:ownerId/pets")).toEqual([
        "teamId",
        "ownerId",
      ]);
    });

    it("reads a parent parameter that shares its segment with literal text", () => {
      expect(parentParamNames("/users/user-:uid/posts")).toEqual(["uid"]);
      expect(parentParamNames("/orgs/:org.json/posts")).toEqual(["org"]);
      expect(parentParamNames('/a/:"user.id"/b')).toEqual(["user.id"]);
      expect(parentParamNames("/r/:from-:to/x")).toEqual(["from", "to"]);
      expect(parentParamNames("/jobs/:job\\:run/logs")).toEqual(["job"]);
    });

    it("reads a quoted name holding a colon or backslash as one parameter", () => {
      expect(parentParamNames('/a/:"x:y"/b')).toEqual(["x:y"]);
      expect(parentParamNames('/a/:"x\\:y"/b')).toEqual(["x\\:y"]);
    });

    it("keeps the last character of a parameter that ends the path", () => {
      expect(parentParamNames("/users/:uid")).toEqual(["uid"]);
      expect(parentParamNames("/users/user-:id")).toEqual(["id"]);
    });

    it("reads hyphen-separated parents as core's route grammar does", () => {
      // A quoted name keeps its hyphens: the quotes end it, not the next param.
      expect(parentParamNames('/r/:"from-":to/x')).toEqual(["from-", "to"]);
      // Every trailing hyphen separates, not only the last one.
      expect(parentParamNames("/r/:from--:to/x")).toEqual(["from", "to"]);
      // A name made only of hyphens names nothing: its colon is literal text.
      expect(parentParamNames("/r/:--:to/x")).toEqual(["to"]);
      // An empty quote is literal text, so the hyphen before it stays a name.
      expect(parentParamNames('/r/:from-:"":to/x')).toEqual(["from-", "to"]);
    });

    it("keeps one collection per embedded parent id through the plugin", async () => {
      const post = {
        type: "object",
        properties: { id: { type: "integer" }, title: { type: "string" } },
      };
      const json = (schema: object) => ({ "application/json": { schema } });
      const uid = {
        name: "uid",
        in: "path",
        required: true,
        schema: { type: "string" },
      };
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: {
            openapi: "3.0.3",
            info: { title: "t", version: "1" },
            paths: {
              "/users/user-{uid}/posts": {
                parameters: [uid],
                get: {
                  responses: {
                    "200": {
                      description: "",
                      content: json({ type: "array", items: post }),
                    },
                  },
                },
                post: {
                  requestBody: { content: json(post) },
                  responses: {
                    "201": { description: "", content: json(post) },
                  },
                },
              },
              "/users/user-{uid}/posts/{id}": {
                parameters: [
                  uid,
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "integer" },
                  },
                ],
                get: {
                  responses: {
                    "200": { description: "", content: json(post) },
                  },
                },
              },
            },
          },
        }),
      );

      const created = await mock.handle("POST", "/users/user-1/posts", {
        body: { title: "x" },
      });
      expect(created.status).toBe(201);
      expect((await mock.handle("GET", "/users/user-2/posts")).body).toEqual(
        [],
      );
      expect((await mock.handle("GET", "/users/user-1/posts")).body).toEqual([
        { id: 1, title: "x" },
      ]);
    });
  });

  describe("scopeSuffix", () => {
    it("is empty for a collection with no parent params", () => {
      expect(scopeSuffix("/pets", {})).toBe("");
      expect(scopeSuffix("/pets", { petId: "1" })).toBe("");
    });

    it("lists parent params with their request values", () => {
      expect(scopeSuffix("/owners/:ownerId/pets", { ownerId: "7" })).toBe(
        "|ownerId=7",
      );
      expect(
        scopeSuffix("/teams/:teamId/owners/:ownerId/pets", {
          teamId: "3",
          ownerId: "7",
        }),
      ).toBe("|teamId=3,ownerId=7");
    });

    it("keeps the parameter position when a value is missing", () => {
      expect(scopeSuffix("/owners/:ownerId/pets", {})).toBe("|ownerId=");
    });

    it("percent-encodes the value only", () => {
      expect(scopeSuffix("/owners/:ownerId/pets", { ownerId: "a|b,c" })).toBe(
        "|ownerId=a%7Cb%2Cc",
      );
    });
  });

  describe("collectionStateKey", () => {
    it("keys a flat collection by its base path", () => {
      expect(collectionStateKey("/pets", {})).toBe("openapi:collections:/pets");
    });

    it("distinguishes same-named collections at different paths", () => {
      expect(collectionStateKey("/users", {})).toBe(
        "openapi:collections:/users",
      );
      expect(collectionStateKey("/admins/users", {})).toBe(
        "openapi:collections:/admins/users",
      );
    });

    it("scopes a nested collection by its parent id", () => {
      expect(
        collectionStateKey("/owners/:ownerId/pets", { ownerId: "7" }),
      ).toBe("openapi:collections:/owners/:ownerId/pets|ownerId=7");
      expect(
        collectionStateKey("/owners/:ownerId/pets", { ownerId: "8" }),
      ).toBe("openapi:collections:/owners/:ownerId/pets|ownerId=8");
    });

    it("ignores the item id parameter", () => {
      expect(collectionStateKey("/pets", { petId: "3" })).toBe(
        "openapi:collections:/pets",
      );
    });
  });

  describe("counterStateKey", () => {
    it("uses the counter prefix with the same scoping", () => {
      expect(counterStateKey("/pets", {})).toBe("openapi:counter:/pets");
      expect(counterStateKey("/owners/:ownerId/pets", { ownerId: "7" })).toBe(
        "openapi:counter:/owners/:ownerId/pets|ownerId=7",
      );
    });
  });

  describe("seededStateKey", () => {
    it("uses the seeded prefix with the same scoping", () => {
      expect(seededStateKey("/pets", {})).toBe("openapi:seeded:/pets");
      expect(seededStateKey("/owners/:ownerId/pets", { ownerId: "7" })).toBe(
        "openapi:seeded:/owners/:ownerId/pets|ownerId=7",
      );
    });
  });
});
