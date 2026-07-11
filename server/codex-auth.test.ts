// Unit tests for the Codex auth-mode detector + --model gating.
//
// Regression context: under `auth_mode: chatgpt` the Codex backend rejects
// every explicit --model argument outside a narrow allowlist with HTTP 400
// ("The '<model>' model is not supported when using Codex with a ChatGPT
// account."). chat.ts uses shouldPassModelFlag() to decide whether to forward
// the persisted model to `codex exec --model <id>` or drop it and let Codex
// pick its built-in default for the active auth mode.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectCodexAuthMode,
  shouldPassModelFlag,
  CODEX_CHATGPT_ALLOWED_MODELS,
} from './codex-auth.js';

describe('detectCodexAuthMode', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-auth-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeAuth = (body: string): void => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'auth.json'), body);
  };

  it('returns mode=unknown when auth.json is missing', () => {
    const info = detectCodexAuthMode(tmp);
    expect(info.mode).toBe('unknown');
    expect(info.present).toBe(false);
    expect(info.path).toBe(join(tmp, 'auth.json'));
  });

  it('detects chatgpt OAuth mode', () => {
    writeAuth(
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'x' },
      }),
    );
    expect(detectCodexAuthMode(tmp).mode).toBe('chatgpt');
  });

  it('detects apikey mode', () => {
    writeAuth(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-xxx' }));
    expect(detectCodexAuthMode(tmp).mode).toBe('apikey');
  });

  it('returns mode=unknown for unrecognized auth_mode values', () => {
    writeAuth(JSON.stringify({ auth_mode: 'something-new' }));
    expect(detectCodexAuthMode(tmp).mode).toBe('unknown');
  });

  it('never throws on malformed JSON — collapses to unknown', () => {
    writeAuth('not-json{{{');
    expect(() => detectCodexAuthMode(tmp)).not.toThrow();
    expect(detectCodexAuthMode(tmp).mode).toBe('unknown');
  });
});

describe('shouldPassModelFlag', () => {
  it('drops the flag when model is falsy regardless of mode', () => {
    expect(shouldPassModelFlag('chatgpt', null)).toBe(false);
    expect(shouldPassModelFlag('apikey', undefined)).toBe(false);
    expect(shouldPassModelFlag('apikey', '')).toBe(false);
  });

  it('passes the flag through under apikey for any model (permissive)', () => {
    // API-key mode accepts every published model; we don't second-guess the CLI.
    for (const m of ['gpt-5.3-codex', 'gpt-5', 'gpt-5-codex', 'gpt-5.1-codex-max']) {
      expect(shouldPassModelFlag('apikey', m)).toBe(true);
    }
  });

  it('passes the flag through under unknown for any model (permissive default)', () => {
    // If we can't read auth.json we assume the legacy behavior.
    expect(shouldPassModelFlag('unknown', 'gpt-5-codex')).toBe(true);
  });

  it('under chatgpt, only the curated allowlist is forwarded', () => {
    for (const m of CODEX_CHATGPT_ALLOWED_MODELS) {
      expect(shouldPassModelFlag('chatgpt', m)).toBe(true);
    }
    // Empirical rejects under auth_mode=chatgpt. gpt-5.3-codex joined this set
    // as of June 2026, and gpt-5.6 as of July 2026 — both rejected under ChatGPT
    // OAuth, so they must be dropped from --model just like the older API-only IDs.
    for (const bad of [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-codex',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.6',
    ]) {
      expect(shouldPassModelFlag('chatgpt', bad)).toBe(false);
    }
  });

  it('allowlist includes the current default so fresh sessions never get dropped', () => {
    // Keep in sync with server/config.ts → engineDefaultModels['codex-cli'].
    expect(CODEX_CHATGPT_ALLOWED_MODELS).toContain('gpt-5.5');
    // Regression: gpt-5.6 was briefly the default but is rejected under ChatGPT
    // OAuth (HTTP 400) and unknown to the installed codex-cli. It must NOT be
    // forwarded — a persisted gpt-5.6 session has to drop --model and fall back.
    expect(CODEX_CHATGPT_ALLOWED_MODELS).not.toContain('gpt-5.6');
    // Regression: the deprecated gpt-5.3-codex must NOT be forwarded under
    // ChatGPT OAuth — it is rejected by the backend and would spin forever.
    expect(CODEX_CHATGPT_ALLOWED_MODELS).not.toContain('gpt-5.3-codex');
  });
});
