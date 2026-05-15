import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

vi.mock('./user-preferences-store.js', () => ({
  getUserPreferencesRow: vi.fn(() => ({})),
}));

import { resolveEffectiveModel } from './effective-model.js';
import { getUserPreferencesRow } from './user-preferences-store.js';

function makeCfg(): AppConfig {
  const engineValidModels = {
    'claude-code': ['allowed-a'],
    'cursor-agent': ['allowed-b'],
  };

  return {
    port: 3051,
    host: '0.0.0.0',
    claudeBin: '/usr/local/bin/claude',
    cursorBin: '/usr/local/bin/agent',
    geminiBin: '/usr/local/bin/gemini',
    codexBin: '/usr/local/bin/codex',
    defaultCwd: '/tmp',
    dataDir: '/tmp',
    projectsDir: '/tmp/projects',
    defaultModel: 'claude-global',
    engineDefaultModels: {
      'claude-code': 'claude-hub',
      'cursor-agent': 'cursor-hub',
    },
    engineValidModels,
    defaultTimeoutMs: 1,
    docsTimeoutMs: 1,
    slackTimeoutMs: 1,
    conferenceTimeoutMs: 1,
    webhookTimeoutMs: 1,
    webhookEventTimeoutMs: {},
    publicUrl: null,
    defaultReviewer: null,
    botGithubToken: null,
    githubApp: null,
    personalOAuth: null,
    apiKey: null,
    anthropicApiKey: null,
    claudeCodeOAuthToken: null,
    openaiApiKey: null,
    geminiApiKey: null,
    codexApiKey: null,
    cursorApiKey: null,
    slackWebhookUrl: null,
    capturesEnabled: false,
    browserMaxConcurrentContexts: 3,
    browserIdleTimeoutMs: 300_000,
    browserAllowDownloads: false,
    browserBlockAdsTrackers: true,
    watchdog: {
      enabled: false,
      idleThresholdMs: 1,
      nudgeCooldownMs: 1,
      checkIntervalMs: 60_000,
      maxSoftNudges: 2,
      cardBudgetMs: 60 * 60 * 1000,
    },
    get allValidModels() {
      return Object.values(engineValidModels).flat();
    },
  } as unknown as AppConfig;
}

describe('resolveEffectiveModel', () => {
  const mockGet = vi.mocked(getUserPreferencesRow);

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockReturnValue({});
  });

  it('returns explicit override first', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ engineDefaultModels: { 'claude-code': 'allowed-a' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      explicitModel: 'explicit',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(m).toBe('explicit');
  });

  it('returns validated user pref before agent model', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ engineDefaultModels: { 'claude-code': 'allowed-a' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'disallowed-on-purpose',
      ownerUserId: 'u1',
    });
    expect(m).toBe('allowed-a');
  });

  it('ignores user pref not in engine allowlist', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ engineDefaultModels: { 'claude-code': 'nope' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'agent-pick',
      ownerUserId: 'u1',
    });
    expect(m).toBe('claude-hub');
  });

  it('uses agent model when it is valid for the engine', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ engineDefaultModels: { 'claude-code': 'nope' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(m).toBe('allowed-a');
  });

  it('falls back to engineDefaultModels when agent empty', () => {
    const cfg = makeCfg();
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      ownerUserId: null,
      agentModel: '',
    });
    expect(m).toBe('claude-hub');
  });

  it('skips user prefs when preferences store throws (orgs.db not ready)', () => {
    const cfg = makeCfg();
    mockGet.mockImplementation(() => {
      throw new Error('orgs.db not initialized — call initOrgsDb() first');
    });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(m).toBe('allowed-a');
  });
});
