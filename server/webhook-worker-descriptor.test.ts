/**
 * Unit tests for `describeWebhookRow` — the helper that builds the
 * one-line, grep-friendly descriptor used in both the wall-timeout error
 * label and the worker's catch-block log line.
 *
 * These tests exist to prevent the old bare-message regression
 * (`[webhook-worker] event N failed: ...wall timeout after 900000ms`) from
 * sneaking back. PM2 logs MUST carry routing context (event key, repo,
 * webhook_config_id, delivery_id) so on-call doesn't need to cross-reference
 * the SQLite queue to figure out which repo / handler / PR a failure
 * belongs to.
 */
import { describe, it, expect } from 'vitest';
import { describeWebhookRow } from './webhook-worker.js';
import type { WebhookEventRow } from './types.js';

function rowFixture(overrides: Partial<WebhookEventRow> = {}): WebhookEventRow {
  return {
    id: 8967,
    webhook_config_id: 3,
    delivery_id: 'abc-123',
    event_type: 'pull_request',
    action: 'synchronize',
    payload: JSON.stringify({
      repository: { full_name: 'Speakman-ai/agent-hub' },
    }),
    signature: null,
    status: 'processing',
    started_at: null,
    completed_at: null,
    error_message: null,
    attempts: 0,
    created_at: '2026-05-18 17:00:00',
    pr_key: null,
    deferred_until: null,
    superseded_by: null,
    ...overrides,
  };
}

describe('describeWebhookRow', () => {
  it('includes event id, event.action key, repo, config id, and delivery id', () => {
    const out = describeWebhookRow(rowFixture());
    expect(out).toBe(
      'event=8967 key=pull_request.synchronize repo=Speakman-ai/agent-hub cfg=3 delivery=abc-123',
    );
  });

  it('uses bare event type when action is null', () => {
    const out = describeWebhookRow(rowFixture({ action: null, event_type: 'ping' }));
    expect(out).toContain('key=ping');
    expect(out).not.toContain('key=ping.');
  });

  it('renders repo=? when payload is malformed JSON', () => {
    // Also confirms pr_key=null forces the JSON-parse fallback so the
    // malformed-payload branch is actually exercised here.
    const out = describeWebhookRow(rowFixture({ pr_key: null, payload: '{not json' }));
    expect(out).toContain('repo=?');
  });

  it('renders repo=? when payload has no repository field', () => {
    const out = describeWebhookRow(rowFixture({ pr_key: null, payload: JSON.stringify({}) }));
    expect(out).toContain('repo=?');
  });

  it('renders delivery=none when delivery_id is null', () => {
    const out = describeWebhookRow(rowFixture({ delivery_id: null }));
    expect(out).toContain('delivery=none');
  });

  it('prefers indexed pr_key over JSON-parsing the payload', () => {
    // pr_key is `<repo_full_name>:<pr_number>`, populated for PR-scoped
    // events. Reading it avoids a JSON.parse on every job and survives a
    // malformed payload — the descriptor must NEVER fall through to the
    // payload parse when pr_key is set.
    const out = describeWebhookRow(
      rowFixture({
        pr_key: 'Speakman-ai/agent-hub:1043',
        // Deliberately broken JSON: if pr_key is preferred, this is never read.
        payload: 'not even json',
      }),
    );
    expect(out).toContain('repo=Speakman-ai/agent-hub');
  });

  it('falls back to JSON parse when pr_key is null (non-PR events)', () => {
    // `push`, `ping`, `create`, … have no PR scope so pr_key is NULL.
    // The payload-parse branch must still resolve the repo for these.
    const out = describeWebhookRow(
      rowFixture({
        pr_key: null,
        event_type: 'push',
        action: null,
        payload: JSON.stringify({ repository: { full_name: 'org/non-pr-repo' } }),
      }),
    );
    expect(out).toContain('repo=org/non-pr-repo');
    expect(out).toContain('key=push');
  });

  it('ignores pr_key when it has no colon (defensive — never expected)', () => {
    // Belt-and-suspenders: if the enqueue path ever wrote a malformed
    // pr_key, we should fall through to the payload parse rather than
    // logging an obviously wrong repo string.
    const out = describeWebhookRow(
      rowFixture({
        pr_key: 'no-colon-here',
        payload: JSON.stringify({ repository: { full_name: 'org/from-payload' } }),
      }),
    );
    expect(out).toContain('repo=org/from-payload');
  });
});
