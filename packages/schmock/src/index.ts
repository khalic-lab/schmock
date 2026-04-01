/**
 * @schmock/schmock — Meta-package that installs all Schmock packages.
 *
 * Usage:
 *   bun install @schmock/schmock
 *
 * This gives you access to all @schmock/* packages:
 *   - @schmock/core — Core mock builder + fetch interceptor
 *   - @schmock/faker — Faker-powered data generation
 *   - @schmock/validation — Request/response validation
 *   - @schmock/query — Pagination, sorting, filtering
 *   - @schmock/openapi — Auto-register routes from OpenAPI specs
 *   - @schmock/cli — Standalone CLI server
 *
 * Framework adapters (install separately):
 *   - @schmock/react — React Provider + hooks
 *   - @schmock/vue — Vue Plugin + composables
 *   - @schmock/express — Express middleware
 *   - @schmock/angular — Angular HTTP interceptor
 *
 * Import from individual packages:
 *   import { schmock } from "@schmock/core";
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
