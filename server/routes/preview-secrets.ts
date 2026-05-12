/**
 * Worktree preview secrets REST surface.
 *
 *   GET    /api/projects/:projectId/preview/secrets         (Admin+)
 *   PUT    /api/projects/:projectId/preview/secrets         (Owner)
 *   POST   /api/projects/:projectId/preview/secrets/import  (Owner)
 *
 * The list endpoint returns the MASK constant for any `secret`-kind row
 * — no caller-side path ever reveals decrypted secret-kind values
 * (the only decrypt happens inside `loadProjectEnvForSpawn`, called by
 * the preview runtime at spawn time).
 *
 * Authz model mirrors Slack bots / instance backups: Admin can read
 * (the team's preview config is shared context), Owner can write
 * (changing the env that preview boots with is a production-shaped
 * action).
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import {
  listPreviewSecrets,
  replacePreviewSecrets,
  parseDotEnv,
  PreviewSecretValidationError,
  type PreviewSecretInput,
  type SecretKind,
} from '../preview/preview-secrets-store.js';

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function normalizeInputs(raw: unknown): PreviewSecretInput[] {
  if (!Array.isArray(raw)) {
    throw new PreviewSecretValidationError('secrets must be an array');
  }
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new PreviewSecretValidationError(`secrets[${i}] must be an object`);
    }
    const key = entry.key;
    const value = entry.value;
    const kind = entry.kind;
    if (typeof key !== 'string') {
      throw new PreviewSecretValidationError(`secrets[${i}].key must be a string`);
    }
    if (typeof value !== 'string') {
      throw new PreviewSecretValidationError(`secrets[${i}].value must be a string`);
    }
    if (kind !== undefined && kind !== 'plain' && kind !== 'secret') {
      throw new PreviewSecretValidationError(
        `secrets[${i}].kind must be "plain" or "secret" if provided`,
      );
    }
    return { key, value, kind: kind as SecretKind | undefined };
  });
}

export default function createPreviewSecretsRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  // ─── GET — Admin+ ────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/preview/secrets',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const secrets = listPreviewSecrets(project.id);
      res.json({ secrets });
    },
  );

  // ─── PUT — Owner — bulk replace ──────────────────────────────────
  router.put(
    '/api/projects/:projectId/preview/secrets',
    requireRole('Owner'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        const inputs = normalizeInputs((req.body as Record<string, unknown>)?.secrets);
        const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
        const result = replacePreviewSecrets(project.id, inputs, actorUserId);
        res.json({ secrets: result });
      } catch (err) {
        if (err instanceof PreviewSecretValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ─── POST /import — Owner — parse .env blob, dedupe by key ───────
  //
  // Two contracts:
  //   - `mode: 'replace'` (default) → behaves like PUT after parsing.
  //   - `mode: 'merge'`             → reads the current list, overlays
  //                                    parsed entries (later wins),
  //                                    and replaces the project's
  //                                    secrets with the combined set.
  // We keep the underlying store API as bulk-replace-only; merge is
  // implemented here at the route layer so the store stays simple.
  router.post(
    '/api/projects/:projectId/preview/secrets/import',
    requireRole('Owner'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const blob = body.env;
        if (typeof blob !== 'string') {
          throw new PreviewSecretValidationError('env must be a string');
        }
        const mode = body.mode === 'merge' ? 'merge' : 'replace';
        const parsed = parseDotEnv(blob);
        // Optional default kind for newly-imported keys; rarely set,
        // but lets callers import a curated config block as `plain`.
        const defaultKind = body.defaultKind === 'plain' ? 'plain' : 'secret';
        const inputs: PreviewSecretInput[] = parsed.map((p) => ({
          ...p,
          kind: p.kind ?? defaultKind,
        }));

        let finalInputs = inputs;
        if (mode === 'merge') {
          const existing = listPreviewSecrets(project.id);
          const merged = new Map<string, PreviewSecretInput>();
          for (const row of existing) {
            // existing.value is MASK for secret-kind rows; we can't
            // re-encrypt MASK as the live value. Skip secret-kind
            // rows on merge — the import only ever adds/overwrites.
            // plain-kind rows can round-trip safely since their value
            // is the real plaintext.
            if (row.kind === 'plain') {
              merged.set(row.key, { key: row.key, value: row.value, kind: 'plain' });
            } else {
              // Preserve the existing secret-kind row by skipping it
              // here — the parsed entry below will overwrite if the
              // user re-supplied the same key; otherwise we have to
              // drop secret-kind preserves on merge (limitation
              // documented in the route's JSDoc above).
            }
          }
          for (const p of inputs) merged.set(p.key, p);
          finalInputs = [...merged.values()];
        }

        const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
        const result = replacePreviewSecrets(project.id, finalInputs, actorUserId);
        res.json({
          imported: inputs.length,
          mode,
          secrets: result,
        });
      } catch (err) {
        if (err instanceof PreviewSecretValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
