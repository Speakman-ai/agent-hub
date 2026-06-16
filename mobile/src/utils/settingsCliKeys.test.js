import { describe, it, expect } from 'vitest';
import {
  CLI_KEY_PROVIDERS,
  providerKeyConfigured,
  providerStatusLabel,
  buildPutMyAuthBody,
  codexDeviceLoginLabel,
  githubStatusLabel,
} from './settingsCliKeys.js';

describe('CLI_KEY_PROVIDERS', () => {
  it('covers all five engines with unique ids', () => {
    const ids = CLI_KEY_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(['claude', 'cursor', 'gemini', 'codex', 'grok']);
  });

  it('grok pastes an xAI key and routes to /auth/me/grok-auth', () => {
    const grok = CLI_KEY_PROVIDERS.find((p) => p.id === 'grok');
    expect(grok).toBeTruthy();
    expect(grok.placeholder).toBe('xai-...');
    // Single-key engines write { apiKey } against /auth/me/<id>-auth.
    expect(buildPutMyAuthBody('grok', ' xai-k ')).toEqual({ apiKey: 'xai-k' });
    expect(providerKeyConfigured('grok', { apiKey: 'xai…1' })).toBe(true);
    expect(providerStatusLabel('grok', { apiKey: null, hostConfigFallback: { apiKey: true } })).toBe(
      'Using host-configured key',
    );
  });
});

describe('providerKeyConfigured', () => {
  it('claude: either API key or OAuth token counts', () => {
    expect(providerKeyConfigured('claude', { anthropicApiKey: 'sk-…abcd' })).toBe(true);
    expect(providerKeyConfigured('claude', { claudeCodeOAuthToken: 'tok…' })).toBe(true);
    expect(
      providerKeyConfigured('claude', { anthropicApiKey: null, claudeCodeOAuthToken: null }),
    ).toBe(false);
  });

  it('single-key engines use apiKey', () => {
    expect(providerKeyConfigured('cursor', { apiKey: 'key…1234' })).toBe(true);
    expect(providerKeyConfigured('gemini', { apiKey: null })).toBe(false);
    expect(providerKeyConfigured('codex', null)).toBe(false);
  });
});

describe('providerStatusLabel', () => {
  it('claude combines key and oauth state', () => {
    expect(
      providerStatusLabel('claude', {
        anthropicApiKey: 'sk-…wxyz',
        claudeCodeOAuthToken: 'tok',
        claudeCodeOAuthExpired: false,
      }),
    ).toBe('API key sk-…wxyz · OAuth token configured');
    expect(
      providerStatusLabel('claude', { claudeCodeOAuthToken: 'tok', claudeCodeOAuthExpired: true }),
    ).toBe('OAuth token (expired)');
    expect(providerStatusLabel('claude', {})).toBe('Not configured');
  });

  it('single-key engines show key, host fallback, or not configured', () => {
    expect(providerStatusLabel('gemini', { apiKey: 'AIza…9' })).toBe('API key AIza…9');
    expect(
      providerStatusLabel('gemini', { apiKey: null, hostConfigFallback: { apiKey: true } }),
    ).toBe('Using host-configured key');
    expect(providerStatusLabel('cursor', { apiKey: null })).toBe('Not configured');
    expect(providerStatusLabel('cursor', null)).toBe('Not configured');
  });
});

describe('buildPutMyAuthBody', () => {
  it('routes claude to anthropicApiKey, others to apiKey', () => {
    expect(buildPutMyAuthBody('claude', ' sk-1 ')).toEqual({ anthropicApiKey: 'sk-1' });
    expect(buildPutMyAuthBody('cursor', 'k')).toEqual({ apiKey: 'k' });
  });

  it('empty input clears the slot with null', () => {
    expect(buildPutMyAuthBody('claude', '  ')).toEqual({ anthropicApiKey: null });
    expect(buildPutMyAuthBody('codex', '')).toEqual({ apiKey: null });
  });
});

describe('codexDeviceLoginLabel', () => {
  it('returns null when no deviceLogin block', () => {
    expect(codexDeviceLoginLabel({})).toBeNull();
    expect(codexDeviceLoginLabel(null)).toBeNull();
  });

  it('labels the known statuses', () => {
    expect(
      codexDeviceLoginLabel({ deviceLogin: { uiStatus: 'authenticated', oauth: { loggedIn: true } } }),
    ).toBe('Signed in with ChatGPT');
    expect(codexDeviceLoginLabel({ deviceLogin: { uiStatus: 'authenticated' } })).toBe('Authenticated');
    expect(codexDeviceLoginLabel({ deviceLogin: { uiStatus: 'pending' } })).toBe('Sign-in in progress…');
    expect(codexDeviceLoginLabel({ deviceLogin: { uiStatus: 'missing' } })).toBe('Not signed in');
  });

  it('passes through unknown statuses readably', () => {
    expect(codexDeviceLoginLabel({ deviceLogin: { uiStatus: 'some_new_state' } })).toBe(
      'some new state',
    );
  });
});

describe('githubStatusLabel', () => {
  it('formats connected/disconnected states', () => {
    expect(githubStatusLabel({ connected: true, login: 'octocat' })).toBe('Connected as @octocat');
    expect(githubStatusLabel({ connected: true })).toBe('Connected');
    expect(githubStatusLabel({ connected: false })).toBe('Not connected');
    expect(githubStatusLabel(null)).toBe('Not connected');
  });
});
