// Singleton OpenAPI registry shared by every route module.
//
// Route files import { registry, registerPath, registerComponent, z } from
// './openapi/registry.js' (note the .js extension per ESM convention — the
// real file is registry.ts) and call the helpers at module load time.
// `server/openapi/generate.ts` then imports every route module to trigger
// those side-effect registrations, walks the registry, and emits a single
// OpenAPI 3.x document.
//
// Why a singleton:
// - Routes are spread across `server/routes/*.ts`; we want one source of
//   truth for paths and schemas without threading a registry instance
//   through every file.
// - Side-effect imports are the documented zod-to-openapi integration
//   pattern (the library is built to be called at module scope).
//
// Hot-reload note: in dev under `tsx --watch`, edits to a route file that
// re-register the same path are tolerated — the underlying registry is an
// array, so duplicate registrations would normally accumulate. The
// generator is a one-shot CLI, so this is only a concern if you `import`
// a route module twice from a long-lived process. None of our paths do
// that today, but if/when they do, we'll need a dedupe layer here.

import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// One-time prototype extension that gives every `z.*` schema a `.openapi()`
// method for attaching OpenAPI metadata (refId, description, example, ...).
// zod-to-openapi requires this to be called before any `register*` call —
// see https://github.com/asteasolutions/zod-to-openapi#the-extendzodwithopenapi-function
// Safe to call multiple times; the library makes it idempotent.
extendZodWithOpenApi(z);

// Re-export `z` so route files only need one import. Using the same `z`
// instance everywhere is important — zod-to-openapi tags schemas with
// metadata stored on the prototype, so a different copy of zod wouldn't
// pick the metadata up.
export { z };
export type { RouteConfig };

/**
 * Process-wide singleton. Cleared by `resetRegistry()` so tests can
 * exercise registration in isolation without polluting the real instance
 * route modules write into.
 */
export let registry = new OpenAPIRegistry();

/**
 * Reset the registry to a fresh instance. Test-only — call this in
 * `beforeEach` to keep registrations from one test from bleeding into the
 * next. Production code should never call this.
 */
export function resetRegistry(): void {
  registry = new OpenAPIRegistry();
}

/**
 * Register an HTTP path / operation. Thin pass-through to the underlying
 * registry — exists so route files don't have to import the singleton
 * directly and so we have a single chokepoint if we ever want to add
 * cross-cutting validation (e.g. "every path must have a `tags` entry").
 */
export function registerPath(config: RouteConfig): void {
  registry.registerPath(config);
}

/**
 * Register a reusable component schema under `#/components/schemas/<name>`.
 * Returns the same schema so call sites can chain:
 *
 *   const User = registerComponent('User', z.object({ ... }));
 *
 * Use this for any schema that's referenced from more than one operation
 * (request bodies, responses, nested types). Inline schemas — used in
 * exactly one operation — don't need a name and can be passed directly to
 * `registerPath`.
 */
export function registerComponent<T extends z.ZodTypeAny>(name: string, schema: T): T {
  // Returning the schema-with-refId (not the original) is what makes
  // downstream usages emit a `$ref` instead of inlining the schema. Call
  // sites should always use the returned reference.
  return registry.register(name, schema) as unknown as T;
}

/**
 * Register a security scheme (bearer auth, API key header, etc.) under
 * `#/components/securitySchemes/<name>`. Routes opt into a scheme by name
 * in their `security` array.
 */
export function registerSecurityScheme(
  name: string,
  scheme: Parameters<OpenAPIRegistry['registerComponent']>[2],
): void {
  registry.registerComponent('securitySchemes', name, scheme);
}
