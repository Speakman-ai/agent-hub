import { describe, it, expect } from 'vitest';
import { buildAuthenticatedModelConfig } from './model-config-auth.js';
import type { AppConfig } from './types.js';

function makeConfig(): AppConfig {
  return {
    port: 3051,
    host: '0.0.0.0',
    claudeBin: '/usr/local/bin/claude',
    cursorBin: '/usr/local/bin/agent',
    geminiBin: '/usr/local/bin/gemini',
    codexBin: '/usr/local/bin/codex',
    grokBin: '/usr/local/bin/grok',
    defaultCwd: '/tmp',
    dataDir: '/tmp',
    projectsDir: '/tmp/projects',
    defaultModel: 'claude-opus-4-8',
    engineDefaultModels: {
      'claude-code': 'claude-opus-4-8',
      'cursor-agent': 'composer-2.5',
      'gemini-cli': 'gemini-2.5-pro',
      'codex-cli': 'gpt-5.3-codex',
    },
    engineValidModels: {
      'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'],
      'cursor-agent': ['composer-2.5'],
      'gemini-cli': ['gemini-2.5-pro'],
      'codex-cli': ['gpt-5.3-codex'],
    },
    defaultTimeoutMs: 1000,
    docsTimeoutMs: 1000,
    slackTimeoutMs: 1000,
    conferenceTimeoutMs: 1000,
    schedulerTimezone: 'UTC',
    scheduledJobsViaQueue: true,
    scheduledJobsConcurrency: 10,
    publicUrl: null,
    defaultReviewer: null,
    personalOAuth: null,
    githubApp: null,
    googleOAuth: null,
    apiKey: null,
    openaiApiKey: null,
    geminiApiKey: null,
    xaiApiKey: null,
    transcriptionProvider: 'openai',
    smtp: {
      enabled: false,
      host: '',
      port: 587,
      tlsMode: 'starttls',
      username: null,
      password: null,
      from: '',
    },
    codexProfile: null,
    sessionEnvAdapter: 'auto' as const,
    codexDangerBypass: true,
    cardDoneOnPush: true,
    slackWebhookUrl: null,
    browserMaxConcurrentContexts: 3,
    browserIdleTimeoutMs: 300_000,
    browserAllowDownloads: false,
    browserBlockAdsTrackers: true,
    artifactsBucket: null,
    artifactsBucketRegion: null,
    replayRetentionDays: 0,
    replayMaskAllEnforced: true,
    previewComposeReadyTimeoutMs: 600_000,
    previewSubdomainBase: null,
    dbInstrumentation: { enabled: false, slowThresholdMs: 10, logSlow: true },
    dbReaderPool: { size: 2, queryTimeoutMs: 30_000, maxQueueDepth: 1_000, busyTimeoutMs: 5_000 },
    get allValidModels() {
      return Object.values(this.engineValidModels).flat();
    },
  };
}

describe('buildAuthenticatedModelConfig', () => {
  it('returns empty model lists/defaults for unauthenticated engines', () => {
    const out = buildAuthenticatedModelConfig(makeConfig(), {
      'claude-code': true,
      'cursor-agent': false,
      'gemini-cli': false,
      'codex-cli': true,
      'grok-cli': false,
    });

    expect(out.engineValidModels['claude-code']).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(out.engineValidModels['codex-cli']).toEqual(['gpt-5.3-codex']);
    expect(out.engineValidModels['cursor-agent']).toEqual([]);
    // gemini-cli is RAG-only — never advertised as a selectable engine, so it
    // is omitted from the maps entirely (not an empty list).
    expect(out.engineValidModels['gemini-cli']).toBeUndefined();
    expect(out.engineDefaultModels['cursor-agent']).toBe('');
    expect(out.engineDefaultModels['gemini-cli']).toBeUndefined();
    expect(out.engineDefaultModels['claude-code']).toBe('claude-opus-4-8');
  });

  it('never advertises the RAG-only gemini-cli engine, even when authenticated', () => {
    // A host with a Gemini RAG key makes gemini-cli "authenticated". It must
    // still be filtered out of the picker feed so it can't be selected as an
    // interactive engine (the CLI free tier is `limit: 0` and hard-429s).
    const out = buildAuthenticatedModelConfig(makeConfig(), {
      'claude-code': true,
      'cursor-agent': true,
      'gemini-cli': true,
      'codex-cli': true,
      'grok-cli': true,
    });

    expect(out.engineValidModels).not.toHaveProperty('gemini-cli');
    expect(out.engineDefaultModels).not.toHaveProperty('gemini-cli');
    // Other engines are unaffected.
    expect(out.engineValidModels['claude-code']).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    // engineAuth still reports gemini presence (used for RAG status display).
    expect(out.engineAuth['gemini-cli']).toBe(true);
  });

  it('uses codexSelectableModels override for the codex engine when provided', () => {
    const cfg = makeConfig();
    cfg.engineDefaultModels['codex-cli'] = 'gpt-5.5';
    cfg.engineValidModels['codex-cli'] = ['gpt-5.5', 'gpt-5.4'];
    const out = buildAuthenticatedModelConfig(
      cfg,
      {
        'claude-code': false,
        'cursor-agent': false,
        'gemini-cli': false,
        'codex-cli': true,
        'grok-cli': false,
      },
      { codexSelectableModels: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'] },
    );
    // Capability-resolved list wins over the static config list.
    expect(out.engineValidModels['codex-cli']).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']);
    // Default stays gpt-5.5 (still present in the override) — no surprise jump.
    expect(out.engineDefaultModels['codex-cli']).toBe('gpt-5.5');
  });

  it('uses the capability-gated Luna default only when the CLI advertises it', () => {
    const cfg = makeConfig();
    cfg.engineDefaultModels['codex-cli'] = 'gpt-5.6-luna';
    cfg.engineValidModels['codex-cli'] = ['gpt-5.5', 'gpt-5.4'];
    const auth = {
      'claude-code': false,
      'cursor-agent': false,
      'gemini-cli': false,
      'codex-cli': true,
      'grok-cli': false,
    } as const;

    expect(buildAuthenticatedModelConfig(cfg, auth).engineDefaultModels['codex-cli']).toBe('');
    expect(
      buildAuthenticatedModelConfig(cfg, auth, {
        codexSelectableModels: ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
      }).engineDefaultModels['codex-cli'],
    ).toBe('gpt-5.6-luna');
  });

  it('override is ignored when codex is unauthenticated (empty list)', () => {
    const cfg = makeConfig();
    const out = buildAuthenticatedModelConfig(
      cfg,
      {
        'claude-code': false,
        'cursor-agent': false,
        'gemini-cli': false,
        'codex-cli': false,
        'grok-cli': false,
      },
      { codexSelectableModels: ['gpt-5.6-sol', 'gpt-5.5'] },
    );
    expect(out.engineValidModels['codex-cli']).toEqual([]);
  });

  it('non-codex engines are unaffected by codexSelectableModels', () => {
    const out = buildAuthenticatedModelConfig(
      makeConfig(),
      {
        'claude-code': true,
        'cursor-agent': false,
        'gemini-cli': false,
        'codex-cli': true,
        'grok-cli': false,
      },
      { codexSelectableModels: ['gpt-5.6-sol'] },
    );
    expect(out.engineValidModels['claude-code']).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(out.engineValidModels['codex-cli']).toEqual(['gpt-5.6-sol']);
  });

  it('filters cursor-agent models to the Hub CLI allowlist when authenticated', () => {
    const cfg = makeConfig();
    cfg.engineValidModels['cursor-agent'] = [
      'gpt-5.3-codex-high',
      'composer-2',
      'composer-2.5',
      'composer-2-fast',
      'auto',
    ];
    cfg.engineDefaultModels['cursor-agent'] = 'gpt-5.3-codex-high';

    const out = buildAuthenticatedModelConfig(cfg, {
      'claude-code': false,
      'cursor-agent': true,
      'gemini-cli': false,
      'codex-cli': false,
      'grok-cli': false,
    });

    expect(out.engineValidModels['cursor-agent']).toEqual(['composer-2.5']);
    expect(out.engineDefaultModels['cursor-agent']).toBe('composer-2.5');
  });

  it('advertises Cursor Grok 4.5 with the exact CLI slug', () => {
    const cfg = makeConfig();
    cfg.engineValidModels['cursor-agent'] = ['cursor-grok-4.5-high'];
    cfg.engineDefaultModels['cursor-agent'] = 'cursor-grok-4.5-high';

    const out = buildAuthenticatedModelConfig(cfg, {
      'claude-code': false,
      'cursor-agent': true,
      'gemini-cli': false,
      'codex-cli': false,
      'grok-cli': false,
    });

    expect(out.engineValidModels['cursor-agent']).toEqual(['cursor-grok-4.5-high']);
    expect(out.engineDefaultModels['cursor-agent']).toBe('cursor-grok-4.5-high');
  });
});
