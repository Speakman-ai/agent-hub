// Capability-gated Codex model exposure.
//
// The Codex CLI writes a `models_cache.json` under its home
// (`$CODEX_HOME` or `~/.codex`) describing exactly which models the *installed*
// binary can serve for the active account:
//
//   {
//     "fetched_at": "...",
//     "etag": "...",
//     "client_version": "0.144.0",
//     "models": [ { "slug": "gpt-5.6-sol", ... }, { "slug": "gpt-5.5", ... }, ... ]
//   }
//
// Newer models (the gpt-5.6 family) require codex-cli >= 0.144.0. On an older
// binary the ChatGPT backend rejects them with HTTP 400 ("requires a newer
// version of Codex") and the cache simply doesn't list them. Rather than
// hard-code a model list that drifts from the installed binary, we derive the
// *capability-gated* slice of the selectable list from this cache at runtime:
// a gated model is offered only when the installed CLI actually advertises its
// slug. This makes exposure self-healing — gpt-5.6-sol appears automatically
// once the host crosses 0.144.0 and its cache refreshes, and never before.
//
// This module is read-only with respect to Codex and never spawns the CLI.
// All reads are wrapped so a missing / malformed cache collapses to "no extra
// capability" (baseline models only) — the safe direction.

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ensurePerUserHome } from './per-user-home.js';
import {
  hasPopulatedCodexDeviceAuth,
  perUserCodexHomePath,
} from './per-user-codex-device-login.js';

/**
 * Codex model IDs that are gated behind installed-CLI capability. These are
 * ChatGPT-usable coding models we're willing to expose, but only once the
 * installed codex-cli proves (via `models_cache.json`) that it can serve them.
 * Ordered newest-first — advertised entries are prepended to the baseline list
 * so the picker surfaces the newest capable model at the top.
 *
 * NOTE: the real Codex IDs are `gpt-5.6-sol` / `-terra` / `-luna`, NOT a bare
 * `gpt-5.6` — the tiered GA (2026-07-09) never shipped an unsuffixed id.
 */
export const CODEX_CAPABILITY_MODELS: readonly string[] = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
];

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-luna';

export interface CodexModelsCache {
  /** `client_version` stamp the cache was written by, or null if absent. */
  clientVersion: string | null;
  /** Set of model slugs the installed CLI advertises for the account. */
  modelSlugs: ReadonlySet<string>;
  /** Absolute path inspected — handy for log lines. */
  path: string;
}

interface MemoEntry {
  mtimeMs: number;
  cache: CodexModelsCache | null;
}

// Path -> last (mtime, parsed cache). `/api/config/models` is polled on a tight
// cadence, so re-parsing a ~170 KB JSON on every request is wasteful. Re-read
// only when the file's mtime changes (a CLI refresh rewrites the file).
const memo = new Map<string, MemoEntry>();

/**
 * Read + parse `<codexHome>/models_cache.json`. Returns null when the file is
 * missing, unreadable, or not valid JSON. Never throws. Memoized by mtime.
 */
export function readCodexModelsCache(codexHome: string): CodexModelsCache | null {
  const path = join(codexHome, 'models_cache.json');

  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    memo.delete(path);
    return null;
  }

  const cached = memo.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.cache;
  }

  const parsed = parseModelsCacheFile(path);
  memo.set(path, { mtimeMs, cache: parsed });
  return parsed;
}

function parseModelsCacheFile(path: string): CodexModelsCache | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as { client_version?: unknown; models?: unknown };
  const clientVersion = typeof obj.client_version === 'string' ? obj.client_version : null;

  const modelSlugs = new Set<string>();
  if (Array.isArray(obj.models)) {
    for (const m of obj.models) {
      if (m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string') {
        modelSlugs.add((m as { slug: string }).slug);
      }
    }
  }

  return { clientVersion, modelSlugs, path };
}

/**
 * The capability-gated models the given cache actually advertises, preserving
 * `CODEX_CAPABILITY_MODELS` order. Empty when the cache is null or advertises
 * none of them.
 */
export function advertisedCapabilityModels(cache: CodexModelsCache | null): string[] {
  if (!cache) return [];
  return CODEX_CAPABILITY_MODELS.filter((slug) => cache.modelSlugs.has(slug));
}

/** Capability-gated models advertised by the Codex home used for a spawn. */
export function advertisedCapabilityModelsForHome(codexHome: string): string[] {
  return advertisedCapabilityModels(readCodexModelsCache(codexHome));
}

export function advertisedCapabilityModelsForEnv(env: {
  CODEX_HOME?: string | undefined;
  HOME?: string | undefined;
}): string[] {
  return advertisedCapabilityModelsForHome(codexHomeFromEnv(env));
}

/**
 * Resolve the selectable Codex model list: capability-gated models the installed
 * CLI advertises (newest-first) followed by the always-available baseline. Any
 * baseline entry that is *also* a gated model (defensive) is de-duplicated.
 */
export function resolveSelectableCodexModels(
  baseline: readonly string[],
  cache: CodexModelsCache | null,
): string[] {
  const advertised = advertisedCapabilityModels(cache);
  const seen = new Set(advertised);
  const rest = baseline.filter((m) => !seen.has(m));
  return [...advertised, ...rest];
}

/**
 * Best-effort codex home for a raw spawn env: `CODEX_HOME` when set, else
 * `<HOME>/.codex`, else the host `~/.codex`. Mirrors how the codex CLI resolves
 * its home so capability reads the same cache a spawn would use.
 */
export function codexHomeFromEnv(env: {
  CODEX_HOME?: string | undefined;
  HOME?: string | undefined;
}): string {
  if (env.CODEX_HOME && env.CODEX_HOME.length > 0) return env.CODEX_HOME;
  if (env.HOME && env.HOME.length > 0) return join(env.HOME, '.codex');
  return join(homedir(), '.codex');
}

/**
 * Ordered codex-home candidates for a request, mirroring the precedence
 * `getEngineAuthStatus` / `buildSpawnEnv` use: the per-user isolated
 * `CODEX_HOME` when device auth is populated, then the per-user `HOME/.codex`,
 * then the host `~/.codex`. Best-effort — any resolution error is skipped.
 */
export function codexHomeCandidatesForUser(
  userId: string | null | undefined,
  dataDir: string | null | undefined,
): string[] {
  const candidates: string[] = [];
  if (userId && dataDir) {
    try {
      if (hasPopulatedCodexDeviceAuth(userId, dataDir)) {
        candidates.push(perUserCodexHomePath(userId, dataDir));
      }
    } catch {
      /* skip */
    }
    try {
      candidates.push(join(ensurePerUserHome(userId, dataDir), '.codex'));
    } catch {
      /* skip */
    }
  }
  candidates.push(join(homedir(), '.codex'));
  return candidates;
}

/**
 * Read the first readable models cache across the user's codex-home candidates.
 * Returns null when none resolve — capability then falls back to baseline only.
 */
export function readCodexModelsCacheForUser(
  userId: string | null | undefined,
  dataDir: string | null | undefined,
): CodexModelsCache | null {
  for (const home of codexHomeCandidatesForUser(userId, dataDir)) {
    const cache = readCodexModelsCache(home);
    if (cache) return cache;
  }
  return null;
}

/** Test-only: drop the mtime memo so a rewritten fixture is re-read. */
export function __resetCodexModelsCacheMemo(): void {
  memo.clear();
}
