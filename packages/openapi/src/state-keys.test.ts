import { describe, expect, it } from "vitest";
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
