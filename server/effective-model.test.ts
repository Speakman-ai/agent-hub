import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

vi.mock('./user-preferences-store.js', () => ({
  getUserPreferencesRow: vi.fn(() => ({})),
}));

import { resolveEffectiveEngineAndModel, resolveEffectiveModel } from './effective-model.js';
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
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      explicitModel: 'explicit',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(m).toBe('explicit');
  });

  it('uses agent model when it is valid for the engine', () => {
    const cfg = makeCfg();
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(m).toBe('allowed-a');
  });

  it('ignores agent model not in engine allowlist and falls back to hub default', () => {
    const cfg = makeCfg();
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'disallowed-on-purpose',
      ownerUserId: 'u1',
    });
    expect(m).toBe('claude-hub');
  });

  it('falls back to engineDefaultModels when agent empty', () => {
    const cfg = makeCfg();
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      ownerUserId: null,
      agentModel: '',
    });
    expect(m).toBe('claude-hub');
  });

  it('does not consult the preferences store when agentId is absent', () => {
    const cfg = makeCfg();
    resolveEffectiveModel(cfg, 'claude-code', {
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('honors the per-user model override when valid for the engine', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ agentModelOverrides: { 'agent-x': 'allowed-a' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentId: 'agent-x',
      ownerUserId: 'u1',
      agentModel: '',
    });
    expect(m).toBe('allowed-a');
    expect(mockGet).toHaveBeenCalledWith('u1');
  });

  it('per-user model override beats the shared agent model', () => {
    const cfg = makeCfg();
    // 'allowed-a' and a second valid model for claude-code.
    cfg.engineValidModels['claude-code'] = ['allowed-a', 'allowed-a2'];
    mockGet.mockReturnValue({ agentModelOverrides: { 'agent-x': 'allowed-a2' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentId: 'agent-x',
      ownerUserId: 'u1',
      agentModel: 'allowed-a',
    });
    expect(m).toBe('allowed-a2');
  });

  it('explicit model still beats the per-user model override', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({ agentModelOverrides: { 'agent-x': 'allowed-a' } });
    const m = resolveEffectiveModel(cfg, 'claude-code', {
      agentId: 'agent-x',
      ownerUserId: 'u1',
      explicitModel: 'explicit',
    });
    expect(m).toBe('explicit');
  });

  it('ignores a per-user model override that is invalid for the engine', () => {
    const cfg = makeCfg();
    // 'allowed-a' belongs to claude-code, not cursor-agent.
    mockGet.mockReturnValue({ agentModelOverrides: { 'agent-x': 'allowed-a' } });
    const m = resolveEffectiveModel(cfg, 'cursor-agent', {
      agentId: 'agent-x',
      ownerUserId: 'u1',
      agentModel: '',
    });
    expect(m).toBe('cursor-hub');
  });
});

describe('resolveEffectiveEngineAndModel', () => {
  const mockGet = vi.mocked(getUserPreferencesRow);

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockReturnValue({});
  });

  it('returns the agent default engine + model when no override exists', () => {
    const cfg = makeCfg();
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(r.engine).toBe('claude-code');
    expect(r.model).toBe('allowed-a');
    expect(r.overrideApplied).toBe(false);
  });

  it("honors a user's per-agent engine override (with override model)", () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({
      agentEngineOverrides: {
        'agent-x': { engine: 'cursor-agent', model: 'allowed-b' },
      },
    });
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    expect(r.engine).toBe('cursor-agent');
    expect(r.model).toBe('allowed-b');
    expect(r.overrideApplied).toBe(true);
  });

  it('falls through to per-engine default when override has no model', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({
      agentEngineOverrides: { 'agent-x': { engine: 'cursor-agent' } },
    });
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a', // belongs to claude-code; must NOT leak into cursor
      ownerUserId: 'u1',
    });
    expect(r.engine).toBe('cursor-agent');
    expect(r.model).toBe('cursor-hub');
    expect(r.overrideApplied).toBe(true);
  });

  it('skips override when ownerUserId is null', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({
      agentEngineOverrides: { 'agent-x': { engine: 'cursor-agent', model: 'allowed-b' } },
    });
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: null,
    });
    expect(r.engine).toBe('claude-code');
    expect(r.model).toBe('allowed-a');
    expect(r.overrideApplied).toBe(false);
  });

  it('explicitEngine wins over per-user override', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({
      agentEngineOverrides: { 'agent-x': { engine: 'cursor-agent', model: 'allowed-b' } },
    });
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
      explicitEngine: 'claude-code',
      explicitModel: 'allowed-a',
    });
    expect(r.engine).toBe('claude-code');
    expect(r.model).toBe('allowed-a');
    expect(r.overrideApplied).toBe(false);
  });

  it('consults the preferences store for both the engine and model maps', () => {
    const cfg = makeCfg();
    mockGet.mockReturnValue({});
    resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    // Once for agentEngineOverrides, once for agentModelOverrides.
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledWith('u1');
  });

  it('applies the per-user model override on the shared engine', () => {
    const cfg = makeCfg();
    cfg.engineValidModels['claude-code'] = ['allowed-a', 'allowed-a2'];
    mockGet.mockReturnValue({ agentModelOverrides: { 'agent-x': 'allowed-a2' } });
    const r = resolveEffectiveEngineAndModel(cfg, {
      agentId: 'agent-x',
      agentEngine: 'claude-code',
      agentModel: 'allowed-a',
      ownerUserId: 'u1',
    });
    // Engine is untouched (shared); only the model reflects the user's pick.
    expect(r.engine).toBe('claude-code');
    expect(r.model).toBe('allowed-a2');
    expect(r.overrideApplied).toBe(false);
  });
});
