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
  listRawPreviewSecretRows,
  replacePreviewSecrets,
  replacePreviewSecretsMixed,
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
  //   - `mode: 'merge'`             → reads the current raw rows,
  //                                    keeps every existing row whose
  //                                    key is NOT in the parsed blob
  //                                    (carrying secret-kind ciphertext
  //                                    through without decrypting), and
  //                                    upserts the parsed entries on
  //                                    top. "Later wins" only when the
  //                                    same key appears in the blob.
  //
  // The merge path uses `replacePreviewSecretsMixed` so secret-kind
  // rows survive a merge even though their value is masked on GET —
  // the store round-trips their ciphertext rather than re-encrypting
  // MASK as plaintext.
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
        // Optional default kind for newly-imported keys; rarely set,
        // but lets callers import a curated config block as `plain`.
        // `parseDotEnv` returns entries with `kind` undefined so this
        // override is the only thing that classifies them.
        const defaultKind: SecretKind = body.defaultKind === 'plain' ? 'plain' : 'secret';
        if (
          body.defaultKind !== undefined &&
          body.defaultKind !== 'plain' &&
          body.defaultKind !== 'secret'
        ) {
          throw new PreviewSecretValidationError(
            'defaultKind must be "plain" or "secret" if provided',
          );
        }
        const parsed = parseDotEnv(blob);
        const inputs: PreviewSecretInput[] = parsed.map((p) => ({
          ...p,
          kind: p.kind ?? defaultKind,
        }));

        const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
        let result;
        if (mode === 'merge') {
          // Pull raw rows so secret-kind ciphertext can round-trip
          // through the merge without ever decrypting it. Rows whose
          // key is also in the parsed blob will be overwritten by the
          // freshly-encrypted input inside `replacePreviewSecretsMixed`.
          const existingRaw = listRawPreviewSecretRows(project.id);
          result = replacePreviewSecretsMixed(project.id, inputs, existingRaw, actorUserId);
        } else {
          result = replacePreviewSecrets(project.id, inputs, actorUserId);
        }
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
