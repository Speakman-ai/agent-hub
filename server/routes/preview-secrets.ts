/**
 * Per-project secrets REST surface.
 *
 *   GET    /api/projects/:projectId/secrets             (Admin+)
 *   PUT    /api/projects/:projectId/secrets             (Owner)
 *   DELETE /api/projects/:projectId/secrets/:key        (Owner)
 *   POST   /api/projects/:projectId/secrets/import      (Owner)
 *
 * Legacy aliases under `/preview/secrets` remain for scripts and older
 * clients. Values are merged into spawned sessions via
 * `mergeProjectSecretsSpawnEnv` — list/GET never returns decrypted
 * `secret`-kind values (MASK sentinel on PUT preserves unchanged rows).
 *
 * Project membership: `requireRole('Admin'/'Owner')` runs after the
 * upstream `createProjectVisibilityGate` middleware mounted in
 * `server/index.ts`, which already 404s requests from callers who don't
 * belong to the project's org. The role check below only narrows that
 * by role — never broadens it. New routes added here must NOT bypass
 * the visibility gate (it is what scopes :projectId to the caller's org).
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
  deletePreviewSecret,
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

const SECRETS_PATHS = [
  '/api/projects/:projectId/secrets',
  '/api/projects/:projectId/preview/secrets',
] as const;

const SECRET_KEY_PATHS = [
  '/api/projects/:projectId/secrets/:key',
  '/api/projects/:projectId/preview/secrets/:key',
] as const;

const IMPORT_PATHS = [
  '/api/projects/:projectId/secrets/import',
  '/api/projects/:projectId/preview/secrets/import',
] as const;

export default function createPreviewSecretsRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  for (const listPath of SECRETS_PATHS) {
    router.get(listPath, requireRole('Admin'), (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const secrets = listPreviewSecrets(project.id);
      res.json({ secrets });
    });

    router.put(listPath, requireRole('Owner'), (req: Request, res: Response) => {
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
    });
  }

  for (const keyPath of SECRET_KEY_PATHS) {
    router.delete(keyPath, requireRole('Owner'), (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const key = req.params.key as string;
      try {
        const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
        const removed = deletePreviewSecret(project.id, key, actorUserId);
        if (!removed) {
          res.status(404).json({ error: `secret "${key}" not found` });
          return;
        }
        // 204 No Content — successful deletes don't return the new list
        // so a caller doing many single-key deletes doesn't pay the
        // listPreviewSecrets cost on each one. Fetch GET /secrets if you
        // need the updated state.
        res.status(204).end();
      } catch (err) {
        if (err instanceof PreviewSecretValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    });
  }

  for (const importPath of IMPORT_PATHS) {
    router.post(importPath, requireRole('Owner'), (req: Request, res: Response) => {
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
    });
  }

  return router;
}
