/**
 * Unit tests for the channel_map dispatch path in server/slack.ts.
 *
 * Covers:
 *   1. dbBotToAccount — parses {label?, agentId?} channel_map shape from JSON
 *   2. dbBotToAccount — calls decryptSecret and surfaces plaintext tokens
 *   3. resolveAgentForChannel — returns override agentId when event.channel matches
 *   4. resolveAgentForChannel — falls back to account.agentId when no entry matches
 *   5. resolveAgentForChannel — falls back to account.agentId when channelId is undefined
 *   6. dbBotToAccount — gracefully ignores bad JSON in channel_map
 *   7. dbBotToAccount — skips entries that have no agentId
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock decryptSecret before importing the module under test.
vi.mock('./secret-crypto.js', () => ({
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
  decryptSecret: vi.fn((v: string) => v.replace(/^enc:/, '')),
}));

import { dbBotToAccount, resolveAgentForChannel } from './slack.js';
import { decryptSecret } from './secret-crypto.js';

// Minimal SlackBotRow fixture — only fields consumed by dbBotToAccount.
function makeRow(
  overrides: Partial<{
    name: string;
    bot_token: string;
    app_token: string;
    agent_id: string;
    channel_map: string;
    enabled: number;
  }> = {},
) {
  return {
    id: 'row-1',
    name: 'test-bot',
    bot_token: 'enc:xoxb-plain',
    app_token: 'enc:xapp-plain',
    agent_id: 'agent-default',
    channel_map: '{}',
    enabled: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dbBotToAccount — channel_map parsing', () => {
  it('parses {label, agentId} shape and builds channelMap', () => {
    const row = makeRow({
      channel_map: JSON.stringify({
        C001: { label: 'frontend', agentId: 'agent-front' },
        C002: { label: 'backend', agentId: 'agent-back' },
      }),
    });
    const account = dbBotToAccount(row);
    expect(account.channelMap).toEqual({
      C001: 'agent-front',
      C002: 'agent-back',
    });
  });

  it('omits entries that have no agentId', () => {
    const row = makeRow({
      channel_map: JSON.stringify({
        C001: { label: 'label-only' }, // no agentId — should be excluded
        C002: { agentId: 'agent-back' }, // included
      }),
    });
    const account = dbBotToAccount(row);
    expect(account.channelMap).toEqual({ C002: 'agent-back' });
  });

  it('returns undefined channelMap when map is empty after filtering', () => {
    const row = makeRow({ channel_map: '{}' });
    const account = dbBotToAccount(row);
    expect(account.channelMap).toBeUndefined();
  });

  it('ignores bad JSON in channel_map without throwing', () => {
    const row = makeRow({ channel_map: 'not-json' });
    expect(() => dbBotToAccount(row)).not.toThrow();
    const account = dbBotToAccount(row);
    expect(account.channelMap).toBeUndefined();
  });
});

describe('dbBotToAccount — token decryption', () => {
  it('calls decryptSecret for bot_token and app_token', () => {
    const row = makeRow({ bot_token: 'enc:xoxb-plain', app_token: 'enc:xapp-plain' });
    dbBotToAccount(row);
    expect(decryptSecret).toHaveBeenCalledWith('enc:xoxb-plain');
    expect(decryptSecret).toHaveBeenCalledWith('enc:xapp-plain');
  });

  it('surfaces plaintext tokens in the returned account', () => {
    const row = makeRow({ bot_token: 'enc:xoxb-plain', app_token: 'enc:xapp-plain' });
    const account = dbBotToAccount(row);
    expect(account.botToken).toBe('xoxb-plain');
    expect(account.appToken).toBe('xapp-plain');
  });

  it('falls back to the raw stored value when decryptSecret throws Malformed ciphertext blob', () => {
    // Simulates a hand-inserted plaintext row (manual SQL fix-up / restored
    // backup): pr-env-store.decryptSecret throws on any blob that isn't
    // iv:tag:ciphertext. The safeDecryptSecret wrapper inside slack.ts
    // should swallow that specific error and forward the raw value, so
    // GET /api/slack/bots and startSlack don't 500 the entire path.
    const decryptSpy = vi.mocked(decryptSecret);
    decryptSpy.mockImplementationOnce(() => {
      throw new Error('[secret-crypto] Malformed ciphertext blob');
    });
    decryptSpy.mockImplementationOnce(() => {
      throw new Error('[secret-crypto] Malformed ciphertext blob');
    });
    const row = makeRow({ bot_token: 'xoxb-legacy-plain', app_token: 'xapp-legacy-plain' });
    const account = dbBotToAccount(row);
    expect(account.botToken).toBe('xoxb-legacy-plain');
    expect(account.appToken).toBe('xapp-legacy-plain');
  });

  it('re-throws non-blob errors so real misconfiguration is not silently masked', () => {
    // Wrong AES key, corrupt blob, etc. should NOT be swallowed — the only
    // recoverable case is the well-known "Malformed ciphertext blob" string.
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const row = makeRow({ bot_token: 'enc:corrupt' });
    expect(() => dbBotToAccount(row)).toThrow(/Unsupported state/);
  });
});

describe('resolveAgentForChannel', () => {
  it('returns the channelMap override when channelId matches', () => {
    const account = {
      name: 'bot',
      botToken: 'tok',
      appToken: 'app',
      agentId: 'agent-default',
      channelMap: { C001: 'agent-front', C002: 'agent-back' },
    };
    expect(resolveAgentForChannel(account, 'C001')).toBe('agent-front');
    expect(resolveAgentForChannel(account, 'C002')).toBe('agent-back');
  });

  it('falls back to account.agentId when channelId has no entry', () => {
    const account = {
      name: 'bot',
      botToken: 'tok',
      appToken: 'app',
      agentId: 'agent-default',
      channelMap: { C001: 'agent-front' },
    };
    expect(resolveAgentForChannel(account, 'C999')).toBe('agent-default');
  });

  it('falls back to account.agentId when channelId is undefined', () => {
    const account = {
      name: 'bot',
      botToken: 'tok',
      appToken: 'app',
      agentId: 'agent-default',
      channelMap: { C001: 'agent-front' },
    };
    expect(resolveAgentForChannel(account, undefined)).toBe('agent-default');
  });

  it('falls back to account.agentId when channelMap is absent', () => {
    const account = {
      name: 'bot',
      botToken: 'tok',
      appToken: 'app',
      agentId: 'agent-default',
    };
    expect(resolveAgentForChannel(account, 'C001')).toBe('agent-default');
  });
});
