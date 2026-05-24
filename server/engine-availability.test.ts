// Tests for the per-engine availability probe. We never shell out for
// real CLIs in tests — the cursor probe is injected, codex auth is read
// from a tmpdir, and Claude OAuth is read from a tmpdir override.
//
// What we're guarding against:
//   - The probe surfacing "available" when no credentials exist.
//   - Expired Claude OAuth being misclassified as valid.
//   - A `no-binary` reason on engines whose CLI isn't installed (so the
//     resolver can render a precise "install X" message).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { probeEngineAvailability, probeAllEngineAvailability } from './engine-availability.js';
import type { AppConfig } from './types.js';

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
    anthropicApiKey: null,
    claudeCodeOAuthToken: null,
    geminiApiKey: null,
    codexApiKey: null,
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
    webhookTimeoutMs: 60000,
    webhookEventTimeoutMs: {},
    publicUrl: null,
    defaultReviewer: null,
    botGithubToken: null,
    githubApp: null,
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
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('probeEngineAvailability — claude-code', () => {
  it('reports available when ANTHROPIC_API_KEY env var is present', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('claude-code', cfg, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      claudeHome: tmpDir, // empty, so OAuth file probe also misses
    });
    expect(r.available).toBe(true);
  });

  it('reports available when claudeCodeOAuthToken is configured', async () => {
    const cfg = makeConfig({ claudeCodeOAuthToken: 'sk-ant-oat-test' });
    const r = await probeEngineAvailability('claude-code', cfg, {
      env: {},
      claudeHome: tmpDir,
    });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when nothing is configured', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('claude-code', cfg, {
      env: {},
      claudeHome: tmpDir, // isolated empty dir — no real ~/.claude
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
    expect(r.detail).toMatch(/claude/i);
  });

  it('reports expired when ~/.claude/.credentials.json holds an expired OAuth token', async () => {
    writeFileSync(
      path.join(tmpDir, '.credentials.json'),
      JSON.stringify({
        // expiresAt in seconds, well in the past
        claudeAiOauth: { expiresAt: Math.floor(Date.now() / 1000) - 3600 },
      }),
      'utf-8',
    );
    const cfg = makeConfig();
    const r = await probeEngineAvailability('claude-code', cfg, {
      env: {},
      claudeHome: tmpDir,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('expired');
  });
});

describe('probeEngineAvailability — cursor-agent', () => {
  it('reports no-binary when cursorBin does not exist', async () => {
    const cfg = makeConfig({ cursorBin: '/no/such/path/cursor-agent' });
    const r = await probeEngineAvailability('cursor-agent', cfg, {
      env: {},
      cursorProbe: async () => true,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports available when the injected cursor probe says authenticated', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('cursor-agent', cfg, {
      env: {},
      cursorProbe: async () => true,
    });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when the cursor probe says unauthenticated', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('cursor-agent', cfg, {
      env: {},
      cursorProbe: async () => false,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — codex-cli', () => {
  it('reports no-binary when codexBin does not exist', async () => {
    const cfg = makeConfig({ codexBin: '/no/such/path/codex' });
    const r = await probeEngineAvailability('codex-cli', cfg, { env: {} });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-binary');
  });

  it('reports available when CODEX_API_KEY env var is set', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('codex-cli', cfg, {
      env: { CODEX_API_KEY: 'sk-xxx' },
    });
    expect(r.available).toBe(true);
  });

  it('reports available when ~/.codex/auth.json declares apikey mode', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }),
      'utf-8',
    );
    const cfg = makeConfig();
    const r = await probeEngineAvailability('codex-cli', cfg, { env: { CODEX_HOME: codexHome } });
    expect(r.available).toBe(true);
  });

  it('reports no-credentials when nothing is configured', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('codex-cli', cfg, {
      // Point CODEX_HOME at an empty dir so detectCodexAuthMode returns absent
      env: { CODEX_HOME: tmpDir },
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeEngineAvailability — gemini-cli', () => {
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

  it('reports no-credentials when nothing is configured', async () => {
    const cfg = makeConfig();
    const r = await probeEngineAvailability('gemini-cli', cfg, { env: {} });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('no-credentials');
  });
});

describe('probeAllEngineAvailability', () => {
  it('returns a record keyed by every supported engine', async () => {
    const cfg = makeConfig();
    const all = await probeAllEngineAvailability(cfg, {
      env: { CODEX_HOME: tmpDir },
      cursorProbe: async () => false,
      claudeHome: tmpDir,
    });
    expect(Object.keys(all).sort()).toEqual(
      ['claude-code', 'codex-cli', 'cursor-agent', 'gemini-cli'].sort(),
    );
    // None configured in this scenario.
    expect(all['claude-code'].available).toBe(false);
    expect(all['cursor-agent'].available).toBe(false);
    expect(all['codex-cli'].available).toBe(false);
    expect(all['gemini-cli'].available).toBe(false);
  });
});
