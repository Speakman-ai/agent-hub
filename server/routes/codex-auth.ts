import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import type { RouteDeps, AppConfig } from '../types.js';

/**
 * Codex CLI auth routes.
 *
 * The Codex CLI supports two auth modes (per
 * https://developers.openai.com/codex/noninteractive):
 *   1. ChatGPT OAuth — stored as a cached token under `$CODEX_HOME` by the
 *      CLI's own `codex login` interactive command.
 *   2. API key via the `OPENAI_API_KEY` (preferred) or `CODEX_API_KEY` env var.
 *
 * Agent Hub ships mode (2) in this first pass since it's the only one that
 * cleanly round-trips through a headless server. Users who want OAuth can run
 * `codex login` at the shell; a future iteration can detect the resulting
 * cache and surface it as "OAuth active" here. API-key management (set /
 * validate / clear) mirrors `routes/gemini-auth.ts` so the frontend auth panel
 * can reuse the same UX pattern.
 */
interface CodexRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCodex(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 30_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d));

    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

export default function createCodexAuthRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  // ── Status ───────────────────────────────────────────────────────────
  router.get('/api/config/codex-auth', (_req: Request, res: Response) => {
    const apiKeyConfigured = !!(
      config.codexApiKey ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY
    );
    const apiKeySource =
      process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
        ? 'environment'
        : config.codexApiKey
          ? 'config'
          : null;

    // Masked preview for UI display when the key is configured.
    const rawKey =
      config.codexApiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || null;
    const masked = rawKey ? `••••••••${rawKey.slice(-4)}` : null;

    res.json({
      apiKey: {
        configured: apiKeyConfigured,
        source: apiKeySource,
        masked,
      },
      activeMethod: apiKeyConfigured ? 'api-key' : 'none',
      // Stub — real OAuth detection would check `$CODEX_HOME/auth.json`. We
      // expose `loggedIn: null` so the UI can treat "unknown" distinctly from
      // "logged out" and instruct users to run `codex login` in the terminal
      // until we wire a server-driven OAuth flow.
      oauth: { loggedIn: null as boolean | null },
    });
  });

  // ── Set / clear API key ──────────────────────────────────────────────
  router.post('/api/config/codex-auth/api-key', (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: unknown };
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    const mutableConfig = config as AppConfig & { codexApiKey: string | null };
    if (apiKey) {
      fileConfig.codexApiKey = apiKey;
      mutableConfig.codexApiKey = apiKey;
    } else {
      delete fileConfig.codexApiKey;
      mutableConfig.codexApiKey = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!apiKey,
      masked: apiKey ? `••••••••${(apiKey as string).slice(-4)}` : null,
    });
  });

  // ── Validate API key against the CLI ─────────────────────────────────
  router.post('/api/config/codex-auth/validate-key', async (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: string };
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    try {
      // `codex exec --json --skip-git-repo-check --sandbox read-only "..."`
      // exits non-zero and prints a 401 message when the key is invalid. A
      // valid key reaches the model and comes back with a completion. We use
      // a 30s timeout since the Responses API can take several seconds to
      // warm up on first hit.
      const { stdout, stderr, code } = await runCodex(
        config.codexBin,
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          'Reply with only the word OK',
        ],
        {
          env: { OPENAI_API_KEY: apiKey, CODEX_API_KEY: apiKey },
          timeout: 30_000,
        },
      );

      // Codex JSONL events — look for a `turn.completed` (success) or a
      // `turn.failed`/`error` carrying 401/auth in the message (failure).
      const combined = stdout + '\n' + stderr;
      const looksAuthFailed = /401|unauthorized|missing bearer|invalid api key/i.test(combined);
      const valid = code === 0 && !looksAuthFailed;

      res.json({
        valid,
        output: valid ? 'API key is valid' : stderr.trim() || stdout.trim() || 'Validation failed',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ valid: false, output: message });
    }
  });

  // ── Clear / logout ───────────────────────────────────────────────────
  router.delete('/api/config/codex-auth', (_req: Request, res: Response) => {
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    delete fileConfig.codexApiKey;
    const mutableConfig = config as AppConfig & { codexApiKey: string | null };
    mutableConfig.codexApiKey = null;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({ ok: true, output: 'Codex API key cleared' });
  });

  return router;
}
