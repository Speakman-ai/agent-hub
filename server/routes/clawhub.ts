import { Router, Request, Response } from 'express';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import matter from 'gray-matter';
import type { RouteDeps } from '../types.js';
import { DEFAULT_SKILLS_DIR, syncSkillsToClaude } from './skills.js';

// ─── In-memory cache (30s TTL) ────────────────────────────────────
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function getCache(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key: string, value: unknown): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Exposed for tests. */
export function __clearClawhubCache(): void {
  cache.clear();
}

// ─── Registry base URL ────────────────────────────────────────────
function registryBase(): string {
  return process.env.CLAWHUB_REGISTRY || 'https://clawhub.ai';
}

async function proxyGet(pathAndQuery: string): Promise<{ status: number; body: unknown }> {
  const url = `${registryBase().replace(/\/$/, '')}${pathAndQuery}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.CLAWHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CLAWHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = { error: 'Non-JSON response from ClawHub' };
  }
  return { status: res.status, body };
}

// ─── Install target resolution ────────────────────────────────────
interface InstallTarget {
  workdir: string;
  dir: string;
  installPath: string;
}

export function resolveInstallTarget(
  body: { target?: unknown; agentId?: unknown; slug?: unknown },
  findAgent: RouteDeps['findAgent'],
): { ok: true; target: InstallTarget } | { ok: false; status: number; error: string } {
  const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  const { target, agentId, slug } = body;
  if (!slug || typeof slug !== 'string') {
    return { ok: false, status: 400, error: 'slug (string) is required' };
  }
  if (!SLUG_RE.test(slug)) {
    return { ok: false, status: 400, error: 'slug contains invalid characters' };
  }
  if (target !== 'agent' && target !== 'global') {
    return { ok: false, status: 400, error: "target must be 'agent' or 'global'" };
  }

  if (target === 'agent') {
    if (!agentId || typeof agentId !== 'string') {
      return {
        ok: false,
        status: 400,
        error: "agentId is required when target is 'agent'",
      };
    }
    const found = findAgent(agentId);
    if (!found) {
      return { ok: false, status: 400, error: `Agent not found: ${agentId}` };
    }
    const ahw = found.project.ahw;
    if (!ahw) {
      return { ok: false, status: 400, error: 'Agent project has no ahw workspace configured' };
    }
    return {
      ok: true,
      target: {
        workdir: ahw,
        dir: 'skills',
        installPath: path.join(ahw, 'skills', slug),
      },
    };
  }

  // target === 'global'
  return {
    ok: true,
    target: {
      workdir: path.dirname(DEFAULT_SKILLS_DIR),
      dir: path.basename(DEFAULT_SKILLS_DIR),
      installPath: path.join(DEFAULT_SKILLS_DIR, slug),
    },
  };
}

// ─── Shell out to npx clawhub install ─────────────────────────────
interface InstallResult {
  exitCode: number;
  stderr: string;
}

function runNpxInstall(
  slug: string,
  version: string | undefined,
  target: InstallTarget,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    const args = ['clawhub@latest', 'install', slug];
    if (version) args.push('--version', version);
    args.push('--workdir', target.workdir, '--dir', target.dir);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // CLAWHUB_TOKEN is already inherited via process.env spread; keep behavior explicit.
    if (process.env.CLAWHUB_TOKEN) env.CLAWHUB_TOKEN = process.env.CLAWHUB_TOKEN;
    if (process.env.CLAWHUB_REGISTRY) env.CLAWHUB_REGISTRY = process.env.CLAWHUB_REGISTRY;

    const proc = spawn('npx', args, { env });
    let stderr = '';
    proc.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString();
    });
    proc.on('error', (err: Error) => {
      resolve({ exitCode: -1, stderr: stderr + `\nspawn error: ${err.message}` });
    });
    proc.on('close', (code: number | null) => {
      resolve({ exitCode: code ?? -1, stderr });
    });
  });
}

function readInstalledFrontmatter(installPath: string): Record<string, unknown> | null {
  const skillMd = path.join(installPath, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  try {
    const raw = readFileSync(skillMd, 'utf-8');
    const { data } = matter(raw);
    return data as Record<string, unknown>;
  } catch (err) {
    console.warn(`Failed to read SKILL.md frontmatter at ${skillMd}:`, err);
    return null;
  }
}

function proxyErrorStatus(err: unknown): number {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 504;
  if (err instanceof DOMException && err.name === 'AbortError') return 504;
  return 502;
}

// ─── Router ───────────────────────────────────────────────────────
export default function createClawhubRoutes(deps: RouteDeps): Router {
  const { findAgent } = deps;
  const router = Router();

  // 1. Search proxy (30s cache)
  router.get('/api/clawhub/search', async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = typeof req.query.limit === 'string' ? req.query.limit : '';
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (limit) qs.set('limit', limit);
      const qsStr = qs.toString();
      const cacheKey = `search?${qsStr}`;
      const cached = getCache(cacheKey);
      if (cached !== null) {
        res.setHeader('X-ClawHub-Cache', 'hit');
        return res.json(cached);
      }
      const { status, body } = await proxyGet(`/api/v1/search${qsStr ? `?${qsStr}` : ''}`);
      if (status >= 200 && status < 300) setCache(cacheKey, body);
      res.setHeader('X-ClawHub-Cache', 'miss');
      res.status(status).json(body);
    } catch (err) {
      res.status(proxyErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  // 2. Skills list (30s cache)
  router.get('/api/clawhub/skills', async (req: Request, res: Response) => {
    try {
      const limit = typeof req.query.limit === 'string' ? req.query.limit : '';
      const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
      const cacheKey = `skills${qs}`;
      const cached = getCache(cacheKey);
      if (cached !== null) {
        res.setHeader('X-ClawHub-Cache', 'hit');
        return res.json(cached);
      }
      const { status, body } = await proxyGet(`/api/v1/skills${qs}`);
      if (status >= 200 && status < 300) setCache(cacheKey, body);
      res.setHeader('X-ClawHub-Cache', 'miss');
      res.status(status).json(body);
    } catch (err) {
      res.status(proxyErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  // 3. Skill detail (no cache)
  router.get('/api/clawhub/skills/:slug', async (req: Request, res: Response) => {
    try {
      const slug = encodeURIComponent(req.params.slug as string);
      const { status, body } = await proxyGet(`/api/v1/skills/${slug}`);
      res.status(status).json(body);
    } catch (err) {
      res.status(proxyErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  // 4. Skill versions (no cache)
  router.get('/api/clawhub/skills/:slug/versions', async (req: Request, res: Response) => {
    try {
      const slug = encodeURIComponent(req.params.slug as string);
      const { status, body } = await proxyGet(`/api/v1/skills/${slug}/versions`);
      res.status(status).json(body);
    } catch (err) {
      res.status(proxyErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  // 5. Install
  router.post('/api/clawhub/install', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      slug?: unknown;
      version?: unknown;
      target?: unknown;
      agentId?: unknown;
    };
    const resolved = resolveInstallTarget(body, findAgent);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const slug = body.slug as string;
    const version = typeof body.version === 'string' ? body.version : undefined;

    try {
      const { exitCode, stderr } = await runNpxInstall(slug, version, resolved.target);
      if (exitCode !== 0) {
        return res.status(500).json({
          error: `clawhub install failed (exit ${exitCode})`,
          stderrTail: stderr.slice(-2000),
        });
      }
      const frontmatter = readInstalledFrontmatter(resolved.target.installPath);

      // Register the freshly-installed skill with the Claude Code CLI
      // without requiring a server restart. The sync function is
      // idempotent and handles both plugin and fallback targets.
      try {
        syncSkillsToClaude([path.join(resolved.target.workdir, resolved.target.dir)]);
      } catch (syncErr) {
        console.warn(
          `[clawhub] Post-install sync to Claude CLI failed for ${slug}:`,
          (syncErr as Error).message,
        );
      }

      return res.json({
        slug,
        installedAt: new Date().toISOString(),
        path: resolved.target.installPath,
        frontmatter,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
