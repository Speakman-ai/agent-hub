/**
 * Zod schemas + OpenAPI registration for `server/routes/desktop-runtime.ts`.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

export const DesktopRuntimeStatusSchema = registerComponent(
  'DesktopRuntimeStatus',
  z
    .object({
      available: z.boolean().openapi({
        description: 'False when the configured backend cannot run on this host (fail closed).',
      }),
      configured: z.enum(['auto', 'container', 'firecracker']).openapi({
        description: 'The `desktopRuntime` config value.',
      }),
      kind: z.enum(['container', 'firecracker']).nullable().openapi({
        description: 'Active backend; null when unavailable.',
      }),
      containerPlacement: z.enum(['runner-fleet', 'hub-docker']).nullable().openapi({
        description: 'Where container desktops run; null for Firecracker or when unavailable.',
      }),
      reason: z.string().openapi({ description: 'Why this backend was chosen, or why none was.' }),
      firecrackerRegistered: z.boolean(),
      screen: z.object({ width: z.number().int(), height: z.number().int() }),
    })
    .openapi({ description: 'Agent desktop runtime backend for this host.' }),
);

registerPath({
  method: 'get',
  path: '/api/desktop/runtime',
  tags: ['Desktop'],
  summary: 'Report the active agent desktop runtime backend and why',
  responses: {
    200: {
      description: 'Backend selection for this host.',
      content: { 'application/json': { schema: DesktopRuntimeStatusSchema } },
    },
  },
});
