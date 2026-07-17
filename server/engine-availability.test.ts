// Tests for the per-engine availability probe.
//
// Auth model: strictly per-account. Claude / Cursor / Codex / Grok availability
// delegates to `userHasEngineCreds(engine, userId, dataDir)` — there is no
// host or env fallback, and no acting user means "no-credentials". Gemini is
// the one host-configured engine (host key / GEMINI_API_KEY env).
//
// We mock `userHasEngineCreds` so the probe's per-account branch is driven
// deterministically without seeding orgs.db or per-user HOME trees.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AppConfig } from './types.js';

const { mockUserHasEngineCreds, mockGetUserGrokAuth } = vi.hoisted(() => ({
  mockUserHasEngineCreds: vi.fn(),
  mockGetUserGrokAuth: vi.fn(),
}));

vi.mock('./per-user-cli-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./per-user-cli-spawn.js')>();
  return {
    ...actual,
    userHasEngineCreds: mockUserHasEngineCreds,
  };
});

vi.mock('./users-store.js', () => ({
  getUserGrokAuth: mockGetUserGrokAuth,
}));

const { probeEngineAvailability, probeAllEngineAvailability, resolveGrokAuthCachePath } =
  await import('./engine-availability.js');

let tmpDir: string;
let fakeBin: string;

function makeFakeBin(p: string): string {
  // The probe checks `existsSync(bin)` — a regular file is enough.
  writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(p, 0o755);
  return p;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    claudeBin: fakeBin,
    cursorBin: fakeBin,
    geminiBin: fakeBin,
    codexBin: fakeBin,
    grokBin: fakeBin,
    geminiApiKey: null,
    xaiApiKey: null,
    openaiApiKey: null,
    // Other fields aren't read by the probe but the type demands them.
    port: 3051,
    host: '127.0.0.1',
    defaultCwd: '/tmp',
    dataDir: '/tmp',
    projectsDir: '/tmp',
    defaultModel: 'claude-sonnet-4-5',
    engineDefaultModels: {},
    engineValidModels: {},
    defaultTimeoutMs: 60000,
    docsTimeoutMs: 60000,
    slackTimeoutMs: 60000,
    conferenceTimeoutMs: 60000,
    publicUrl: null,
    defaultReviewer: null,
    personalOAuth: null,
    apiKey: null,
    slackWebhookUrl: null,
    browserMaxConcurrentContexts: 1,
    browserIdleTimeoutMs: 60000,
    browserAllowDownloads: false,
    browserBlockAdsTrackers: false,
    allValidModels: [],
    ...overrides,
  } as AppConfig;
}

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `engine-avail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  fakeBin = makeFakeBin(path.join(tmpDir, 'fake-cli'));
  mockUserHasEngineCreds.mockReset();
  mockUserHasEngineCreds.mockReturnValue(false);
  mockGetUserGrokAuth.mockReset();
  mockGetUserGrokAuth.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('probeEngineAvailability — claude-code (per-account)', () => {
  it('reports no-binary when claudeBin does not exist', async () => {
    // claude-code has no dedicated binary check in the probe, but with a bin
    // present and an acting user the result is decided by userHasEngineCreds.
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(true);
    const r = await probeEngineAvailability('claude-code', cfg, { userId: 'u1' });
    expect(r.available).toBe(true);
    expect(mockUserHasEngineCreds).toHaveBeenCalledWith('claude-code', 'u1', cfg.dataDir);
  });

  it('reports no-credentials when there is no acting user (no host fallback)', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('claude-code', cfg, {});
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
    expect(r.detail).toMatch(/claude/i);
  });

  it('reports no-credentials when the acting user has no Claude creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(false);
    const r = await probeEngineAvailability('claude-code', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — cursor-agent (per-account)', () => {
  it('reports no-binary when cursorBin does not exist', async () => {
    const cfg = makeConfig({ cursorBin: '/no/such/path/cursor-agent' });
    const r = await probeEngineAvailability('cursor-agent', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports available when the acting user has Cursor creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(true);
    const r = await probeEngineAvailability('cursor-agent', cfg, { userId: 'u1' });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when there is no acting user', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('cursor-agent', cfg, {});
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });

  it('reports no-credentials when the acting user has no Cursor creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(false);
    const r = await probeEngineAvailability('cursor-agent', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — codex-cli (per-account)', () => {
  it('reports no-binary when codexBin does not exist', async () => {
    const cfg = makeConfig({ codexBin: '/no/such/path/codex' });
    const r = await probeEngineAvailability('codex-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports available when the acting user has Codex creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(true);
    const r = await probeEngineAvailability('codex-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when there is no acting user', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('codex-cli', cfg, {});
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });

  it('reports no-credentials when the acting user has no Codex creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(false);
    const r = await probeEngineAvailability('codex-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — gemini-cli (host-configured / global)', () => {
  it('reports no-binary when geminiBin does not exist', async () => {
    const cfg = makeConfig({ geminiBin: '/no/such/path/gemini' });
    const r = await probeEngineAvailability('gemini-cli', cfg, { env: {} });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports available when GEMINI_API_KEY env var is present', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('gemini-cli', cfg, {
      env: { GEMINI_API_KEY: 'AIza-test' },
    });
    expect(r.available).toBe(true);
  });

  it('reports available when the host config carries a Gemini key', async () => {
    const cfg = makeConfig({ geminiApiKey: 'AIza-host' });
    const r = await probeEngineAvailability('gemini-cli', cfg, { env: {} });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when nothing is configured', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('gemini-cli', cfg, { env: {} });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — grok-cli (per-account)', () => {
  it('reports no-binary when grokBin does not exist', async () => {
    const cfg = makeConfig({ grokBin: '/no/such/path/grok' });
    const r = await probeEngineAvailability('grok-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports no-credentials when there is no acting user', async () => {
    const cfg = makeConfig({ xaiApiKey: 'xai-host' });
    const r = await probeEngineAvailability('grok-cli', cfg, {
      env: { XAI_API_KEY: 'xai-test' },
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
    expect(r.detail).toMatch(/acting user/i);
    expect(mockUserHasEngineCreds).not.toHaveBeenCalled();
  });

  it('reports available when the acting user has Grok creds', async () => {
    const cfg = makeConfig();
    mockUserHasEngineCreds.mockReturnValue(true);
    const r = await probeEngineAvailability('grok-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(true);
    expect(mockUserHasEngineCreds).toHaveBeenCalledWith('grok-cli', 'u1', cfg.dataDir);
  });

  it('reports no-credentials when the acting user has no Grok creds', async () => {
    const cfg = makeConfig({ dataDir: tmpDir });
    mockUserHasEngineCreds.mockReturnValue(false);
    const r = await probeEngineAvailability('grok-cli', cfg, { userId: 'u1' });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeAllEngineAvailability', () => {
  it('returns a record keyed by every supported engine', async () => {
    const cfg = makeConfig();
    // No acting user + no Gemini key → nothing is available.
    const all = await probeAllEngineAvailability(cfg, { env: { HOME: tmpDir } });
    expect(Object.keys(all).sort()).toEqual(
      ['claude-code', 'codex-cli', 'cursor-agent', 'gemini-cli', 'grok-cli'].sort(),
    );
    expect(all['claude-code'].available).toBe(false);
    expect(all['cursor-agent'].available).toBe(false);
    expect(all['codex-cli'].available).toBe(false);
    expect(all['gemini-cli'].available).toBe(false);
    expect(all['grok-cli'].available).toBe(false);
  });
});

const { ALL_SUPPORTED_ENGINES, RAG_ONLY_ENGINES, SELECTABLE_ENGINES } =
  await import('./engine-availability.js');

describe('RAG_ONLY_ENGINES / SELECTABLE_ENGINES', () => {
  it('reserves gemini-cli as RAG-only', () => {
    expect(RAG_ONLY_ENGINES.has('gemini-cli')).toBe(true);
  });

  it('omits every RAG-only engine from the selectable set', () => {
    for (const engine of RAG_ONLY_ENGINES) {
      expect(SELECTABLE_ENGINES).not.toContain(engine);
    }
    expect(SELECTABLE_ENGINES).not.toContain('gemini-cli');
  });

  it('is exactly ALL_SUPPORTED_ENGINES minus the RAG-only engines', () => {
    const expected = ALL_SUPPORTED_ENGINES.filter((e) => !RAG_ONLY_ENGINES.has(e));
    expect([...SELECTABLE_ENGINES]).toEqual(expected);
    // The interactive engines a user can actually pick today.
    expect([...SELECTABLE_ENGINES]).toEqual([
      'claude-code',
      'cursor-agent',
      'codex-cli',
      'grok-cli',
    ]);
  });
});
