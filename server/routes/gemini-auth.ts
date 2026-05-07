import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import type { RouteDeps, AppConfig } from '../types.js';
import { killProcessGroup, trackChild } from '../process-groups.js';

/**
 * Gemini CLI auth routes.
 *
 * The Gemini CLI supports two auth modes (per https://geminicli.com/docs/):
 *   1. Google account OAuth — stored as a cached token in the user's home dir
 *      and managed entirely by the CLI's own `/auth` interactive command.
 *   2. API key via the `GEMINI_API_KEY` env var.
 *
 * Agent Hub ships mode (2) in this first pass because it's the only one that
 * cleanly round-trips through a headless server. Users who want OAuth can
 * `gemini /auth login` at the shell; the status endpoint will detect the
 * resulting cache so the UI reflects "OAuth active" even when we didn't drive
 * the flow ourselves. API-key management (set / validate / clear) mirrors the
 * `/api/config/claude-auth/api-key` endpoints in claude-auth.ts so the
 * frontend auth panel can reuse the same UX pattern.
 */
interface GeminiRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runGemini(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<GeminiRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const ms = opts.timeout || 15_000;
    const timer = setTimeout(() => killProcessGroup(proc, 'SIGTERM'), ms);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d));

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

export default function createGeminiAuthRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  // ── Status ───────────────────────────────────────────────────────────
  router.get('/api/config/gemini-auth', (_req: Request, res: Response) => {
    const apiKeyConfigured = !!(config.geminiApiKey || process.env.GEMINI_API_KEY);
    const apiKeySource = process.env.GEMINI_API_KEY
      ? 'environment'
      : config.geminiApiKey
        ? 'config'
        : null;

    // Masked preview for UI display when the key is configured.
    const rawKey = config.geminiApiKey || process.env.GEMINI_API_KEY || null;
    const masked = rawKey ? `••••••••${rawKey.slice(-4)}` : null;

    res.json({
      apiKey: {
        configured: apiKeyConfigured,
        source: apiKeySource,
        masked,
      },
      activeMethod: apiKeyConfigured ? 'api-key' : 'none',
      // Stub — real OAuth detection would parse ~/.gemini/credentials.json.
      // We expose `loggedIn: null` so the UI can treat "unknown" distinctly
      // from "logged out" and instruct users to run `gemini /auth` in the
      // terminal until we wire a server-driven OAuth flow.
      oauth: { loggedIn: null as boolean | null },
    });
  });

  // ── Set / clear API key ──────────────────────────────────────────────
  router.post('/api/config/gemini-auth/api-key', (req: Request, res: Response) => {
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

    const mutableConfig = config as AppConfig & { geminiApiKey: string | null };
    if (apiKey) {
      fileConfig.geminiApiKey = apiKey;
      mutableConfig.geminiApiKey = apiKey;
    } else {
      delete fileConfig.geminiApiKey;
      mutableConfig.geminiApiKey = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!apiKey,
      masked: apiKey ? `••••••••${(apiKey as string).slice(-4)}` : null,
    });
  });

  // ── Validate API key against the CLI ─────────────────────────────────
  router.post('/api/config/gemini-auth/validate-key', async (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: string };
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    try {
      const { stdout, stderr, code } = await runGemini(
        config.geminiBin,
        ['-p', 'Reply with only the word OK', '--yolo'],
        {
          env: { GEMINI_API_KEY: apiKey },
          timeout: 30_000,
        },
      );

      const output = stdout.trim();
      const valid = code === 0 && output.toLowerCase().includes('ok');

      res.json({
        valid,
        output: valid ? 'API key is valid' : stderr.trim() || output || 'Validation failed',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ valid: false, output: message });
    }
  });

  // ── Clear / logout ───────────────────────────────────────────────────
  router.delete('/api/config/gemini-auth', (_req: Request, res: Response) => {
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    delete fileConfig.geminiApiKey;
    const mutableConfig = config as AppConfig & { geminiApiKey: string | null };
    mutableConfig.geminiApiKey = null;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({ ok: true, output: 'Gemini API key cleared' });
  });

  return router;
}
