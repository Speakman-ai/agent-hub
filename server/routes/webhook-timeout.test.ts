/**
 * Unit tests for `resolveWebhookTimeoutMs` — the helper that picks the
 * timeout (ms) for a webhook-dispatched Claude run.
 *
 * Pinning the resolution rule here so the
 * `pull_request_review.submitted` regression (5-min default that wasn't
 * enough for full PR review prompts) cannot return silently.
 */
import { describe, it, expect } from 'vitest';
import { resolveWebhookTimeoutMs } from './webhooks.js';
import type { AppConfig } from '../types.js';

type Cfg = Pick<AppConfig, 'webhookEventTimeoutMs' | 'webhookTimeoutMs' | 'defaultTimeoutMs'>;

const baseCfg = (overrides: Partial<Cfg> = {}): Cfg => ({
  webhookEventTimeoutMs: {},
  webhookTimeoutMs: 20 * 60 * 1000,
  defaultTimeoutMs: 15 * 60 * 1000,
  ...overrides,
});

describe('resolveWebhookTimeoutMs', () => {
  it('returns the event.action override when present', () => {
    const cfg = baseCfg({
      webhookEventTimeoutMs: { 'pull_request_review.submitted': 30 * 60 * 1000 },
    });
    expect(resolveWebhookTimeoutMs('pull_request_review', 'submitted', cfg)).toBe(30 * 60 * 1000);
  });

  it('falls back to a bare event override when there is no event.action key', () => {
    const cfg = baseCfg({ webhookEventTimeoutMs: { pull_request_review: 25 * 60 * 1000 } });
    expect(resolveWebhookTimeoutMs('pull_request_review', 'submitted', cfg)).toBe(25 * 60 * 1000);
  });

  it('prefers event.action over the bare event when both exist', () => {
    const cfg = baseCfg({
      webhookEventTimeoutMs: {
        pull_request_review: 25 * 60 * 1000,
        'pull_request_review.submitted': 30 * 60 * 1000,
      },
    });
    expect(resolveWebhookTimeoutMs('pull_request_review', 'submitted', cfg)).toBe(30 * 60 * 1000);
  });

  it('falls back to webhookTimeoutMs when no event override matches', () => {
    const cfg = baseCfg();
    expect(resolveWebhookTimeoutMs('push', '', cfg)).toBe(20 * 60 * 1000);
  });

  it('falls back to defaultTimeoutMs when webhookTimeoutMs is unusable', () => {
    const cfg = baseCfg({ webhookTimeoutMs: 0 });
    expect(resolveWebhookTimeoutMs('push', '', cfg)).toBe(15 * 60 * 1000);
  });

  it('treats non-finite or non-positive overrides as missing', () => {
    const cfg = baseCfg({
      webhookEventTimeoutMs: {
        'pull_request_review.submitted': Number.NaN as unknown as number,
        pull_request_review: -1 as unknown as number,
      },
    });
    expect(resolveWebhookTimeoutMs('pull_request_review', 'submitted', cfg)).toBe(20 * 60 * 1000);
  });

  it('handles an empty action correctly (does not produce a "event." lookup)', () => {
    // The map intentionally seeds two keys: the legitimate bare-event
    // override (`push`) and a deliberately-unreachable trap key (`push.`).
    // We assert the resolver picks `push` (18m) — proving the empty
    // action does NOT cause us to look up `<event>.` (the trap, 99m).
    const cfg = baseCfg({
      webhookEventTimeoutMs: {
        push: 18 * 60 * 1000,
        'push.': 99 * 60 * 1000, // unreachable when action === ''
      },
    });
    expect(resolveWebhookTimeoutMs('push', '', cfg)).toBe(18 * 60 * 1000);
    // Sanity: the trap key really IS in the map; we're not just asserting
    // a missing-key fallback. If the resolver ever starts concatenating
    // `event + '.'` for empty actions, it would return 99m and this
    // assertion would fail.
    expect(cfg.webhookEventTimeoutMs['push.']).toBe(99 * 60 * 1000);
  });

  it('falls through cleanly when webhookEventTimeoutMs is undefined', () => {
    const cfg = {
      webhookEventTimeoutMs: undefined as unknown as Record<string, number>,
      webhookTimeoutMs: 20 * 60 * 1000,
      defaultTimeoutMs: 15 * 60 * 1000,
    };
    expect(resolveWebhookTimeoutMs('pull_request_review', 'submitted', cfg)).toBe(20 * 60 * 1000);
  });
});
