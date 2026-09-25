/**
 * @schmock/schmock — All-in-one install that pulls in the non-adapter Schmock packages.
 *
 * Usage:
 *   bun add -d @schmock/schmock
 *
 * This package re-exports only `schmock` and the response helpers
 * (badRequest, created, forbidden, noContent, notFound, paginate,
 * serverError, unauthorized) from @schmock/core.
 *
 * It also pulls in these packages as its own dependencies:
 *   - @schmock/core — Core mock builder + fetch interceptor
 *   - @schmock/faker — Faker-powered data generation
 *   - @schmock/validation — Request/response validation
 *   - @schmock/query — Pagination, sorting, filtering
 *   - @schmock/openapi — Auto-register routes from OpenAPI specs
 *   - @schmock/cli — Standalone CLI server
 *
 * A strict layout (pnpm, Yarn PnP, `bun install --linker isolated`) does not
 * let your code import or run a transitive dependency. Add every package you
 * import, and @schmock/cli if you run the `schmock` command, as a direct
 * dependency:
 *   bun add -d @schmock/schmock @schmock/openapi
 *
 * Framework adapters (install separately):
 *   - @schmock/react — React Provider + hooks
 *   - @schmock/vue — Vue Plugin + composables
 *   - @schmock/express — Express middleware
 *   - @schmock/angular — Angular HTTP interceptor
 *
 * Usage with a directly installed package:
 *   import { schmock } from "@schmock/schmock";
 *   import { openapi } from "@schmock/openapi";
 */
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  schmock,
  serverError,
  unauthorized,
} from "@schmock/core";
