/**
 * @schmock/schmock — Meta-package that installs all Schmock packages.
 *
 * Usage:
 *   bun install @schmock/schmock
 *
 * This gives you access to all @schmock/* packages:
 *   - @schmock/core — Core mock builder
 *   - @schmock/faker — Faker-powered data generation
 *   - @schmock/validation — Request/response validation
 *   - @schmock/query — Pagination, sorting, filtering
 *   - @schmock/openapi — Auto-register routes from OpenAPI specs
 *   - @schmock/express — Express middleware adapter
 *   - @schmock/angular — Angular HTTP interceptor adapter
 *   - @schmock/cli — Standalone CLI server
 *
 * Import from individual packages:
 *   import { schmock } from "@schmock/core";
 *   import { openapi } from "@schmock/openapi";
 *   import { toExpress } from "@schmock/express";
 */
export { schmock } from "@schmock/core";
