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
    webhookTimeoutMs: 1000,
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
    codexProfile: null,
    codexDangerBypass: true,
    lanMode: false,
    cursorApiKey: null,
    slackWebhookUrl: null,
    browserMaxConcurrentContexts: 3,
    browserIdleTimeoutMs: 300_000,
    browserAllowDownloads: false,
    browserBlockAdsTrackers: true,
    previewComposeReadyTimeoutMs: 600_000,
    previewSubdomainBase: null,
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
    });

    expect(out.engineValidModels['claude-code']).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(out.engineValidModels['codex-cli']).toEqual(['gpt-5.3-codex']);
    expect(out.engineValidModels['cursor-agent']).toEqual([]);
    expect(out.engineValidModels['gemini-cli']).toEqual([]);
    expect(out.engineDefaultModels['cursor-agent']).toBe('');
    expect(out.engineDefaultModels['gemini-cli']).toBe('');
    expect(out.engineDefaultModels['claude-code']).toBe('claude-opus-4-8');
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
    });

    expect(out.engineValidModels['cursor-agent']).toEqual(['composer-2.5']);
    expect(out.engineDefaultModels['cursor-agent']).toBe('composer-2.5');
  });
});
