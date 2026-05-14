import { Router, type Request, type Response, type NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The committed OpenAPI spec lives at <repo>/docs/api/openapi.yaml. From
// server/routes/ that's two levels up.
//
// In packaged Electron builds the `docs/` tree is NOT listed in asarUnpack
// (see root package.json), so the file may not be reachable at runtime.
// When it's missing we render a friendly placeholder instead of crashing.
export const DEFAULT_OPENAPI_YAML_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'api',
  'openapi.yaml',
);

const FALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>Agent Hub API Docs</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:4em auto;color:#222">
  <h1>API docs not bundled</h1>
  <p>This build does not ship <code>docs/api/openapi.yaml</code>. The interactive
  Swagger UI is only available when running Agent Hub from source (or any
  build that includes the <code>docs/</code> tree).</p>
  <p>For the published spec, see the Agent Hub repository.</p>
</body></html>`;

/**
 * Mounts an in-app Swagger UI at `/api/docs` that renders the generated
 * OpenAPI spec served from disk. Kept intentionally simple — read-only,
 * no auth gate — so self-hosters can poke at the API without leaving the app.
 *
 * The spec itself is committed and regenerated via `npm run generate:openapi`;
 * this route just serves the bytes and the UI shell.
 *
 * @param openapiYamlPath Override the spec path (primarily for tests).
 */
export function createApiDocsRoutes(
  openapiYamlPath = DEFAULT_OPENAPI_YAML_PATH,
): Router {
  // Read the spec once at router-creation time. A single try/catch collapses
  // the existsSync→readFileSync TOCTOU race into one syscall and avoids
  // disk I/O on every request to /api/docs/openapi.yaml.
  let yamlContent: string | null;
  try {
    yamlContent = readFileSync(openapiYamlPath, 'utf-8');
  } catch {
    yamlContent = null;
  }

  const router = Router();

  // Serve the raw spec at a stable URL so the Swagger UI shell can fetch it.
  // We deliberately do NOT parse the YAML server-side: keeps the dependency
  // surface small and avoids drift between the file and an in-memory copy.
  router.get('/api/docs/openapi.yaml', (_req: Request, res: Response) => {
    if (yamlContent === null) {
      return res.status(404).type('text/plain').send('openapi.yaml not bundled with this build');
    }
    res.type('application/yaml').send(yamlContent);
  });

  // Short-circuit with a friendly page when the spec is missing so the UI
  // doesn't render a permanently-broken "Failed to load API definition".
  router.use('/api/docs', (_req: Request, res: Response, next: NextFunction) => {
    if (yamlContent === null) {
      return res.status(404).type('text/html').send(FALLBACK_HTML);
    }
    return next();
  });

  const swaggerOptions: swaggerUi.SwaggerUiOptions = {
    explorer: false,
    customSiteTitle: 'Agent Hub API Docs',
    swaggerOptions: {
      // Point the UI at the YAML endpoint above instead of inlining the spec.
      url: '/api/docs/openapi.yaml',
    },
  };

  router.use(
    '/api/docs',
    swaggerUi.serveFiles(undefined, swaggerOptions),
    swaggerUi.setup(undefined, swaggerOptions),
  );

  return router;
}
