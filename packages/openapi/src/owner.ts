/**
 * Route ownership marker.
 *
 * The OpenAPI plugin must only inspect routes it registered itself: a manually
 * registered route (or a route registered by a *different* `openapi()` instance
 * piped onto the same mock) has no `openapi:*` metadata, so the request pipeline
 * would fall back to this plugin's global security, negotiation and validation
 * and reject a request that has nothing to do with this spec.
 *
 * The marker is a plain string `RouteConfig` key rather than a `WeakMap` or a
 * `Symbol`: `defineRoute` shallow-clones the caller's config and hands the clone
 * to `context.route`, so an object-identity marker can never round-trip, while a
 * string key survives the spread and matches the documented `openapi:*`
 * extension convention.
 */

import type * as Schmock from "@schmock/core";

/** `RouteConfig` key stamping which `openapi()` instance registered a route. */
export const OWNER_KEY = "openapi:owner";

let ownerSeq = 0;

/**
 * Mint a token unique to one `openapi()` plugin instance.
 *
 * The random suffix keeps tokens distinct even when the module is instantiated
 * twice (dual bundling), where a bare counter could collide.
 */
export function createOwnerToken(): string {
  ownerSeq += 1;
  return `@schmock/openapi#${ownerSeq}.${Math.random().toString(36).slice(2, 10)}`;
}

/** Does this route belong to the plugin instance holding `token`? */
export function isOwnedRoute(
  route: Schmock.RouteConfig,
  token: string,
): boolean {
  return route[OWNER_KEY] === token;
}
