import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeInfraDb, getInfraDb, initInfraDb } from './infra-db.js';
import {
  deliverInfraAlertOutboxBatch,
  enqueueInfraAlertEmail,
  INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
  INFRA_ALERT_OUTBOX_RETRY_BACKOFF_MINUTES,
  listRetryEligibleInfraAlertOutbox,
  nextInfraAlertAttemptAt,
} from './alert-outbox.js';
import { sendEmailResult } from '../email-sender.js';

vi.mock('../email-sender.js', () => ({
  sendEmailResult: vi.fn(),
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-outbox-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('infra alert email outbox', () => {
  it('deduplicates a repeated transition for the same recipient', () => {
    const input = {
      projectId: 'project-a',
      alertId: 'alert-a',
      severity: 'critical' as const,
      transitionKey: 'alert-a:transition-1',
      recipientEmail: ' Ops@Example.com ',
      subject: 'Alert',
      bodyText: 'Body',
    };
    const first = enqueueInfraAlertEmail(input);
    const second = enqueueInfraAlertEmail(input);
    expect(first.id).toBe(second.id);
    expect(getInfraDb().prepare('SELECT COUNT(*) AS count FROM infra_alert_outbox').get()).toEqual({
      count: 1,
    });
  });

  it('uses the 5/15/60/240 minute retry schedule and stops at five attempts', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    expect(INFRA_ALERT_OUTBOX_RETRY_BACKOFF_MINUTES).toEqual([5, 15, 60, 240]);
    expect(nextInfraAlertAttemptAt(1, now)).toBe('2026-08-06 12:05:00');
    expect(nextInfraAlertAttemptAt(2, now)).toBe('2026-08-06 12:15:00');
    expect(nextInfraAlertAttemptAt(3, now)).toBe('2026-08-06 13:00:00');
    expect(nextInfraAlertAttemptAt(4, now)).toBe('2026-08-06 16:00:00');
    expect(nextInfraAlertAttemptAt(INFRA_ALERT_OUTBOX_MAX_ATTEMPTS, now)).toBeNull();
  });

  it('retries a stale fifth-attempt claim after a process crash', async () => {
    getInfraDb()
      .prepare(
        `INSERT INTO infra_alert_outbox
           (id, project_id, alert_id, severity, transition_key, recipient_email,
            subject, body_text, status, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, datetime('now', '-16 minutes'))`,
      )
      .run(
        'outbox-fifth-attempt',
        'project-a',
        'alert-a',
        'critical',
        'alert-a:transition-1',
        'ops@example.com',
        'Alert',
        'Body',
        INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
      );
    vi.mocked(sendEmailResult).mockResolvedValue({ sent: true });

    expect(listRetryEligibleInfraAlertOutbox()).toHaveLength(1);
    const [row] = await deliverInfraAlertOutboxBatch();

    expect(sendEmailResult).toHaveBeenCalledWith({
      to: 'ops@example.com',
      subject: 'Alert',
      text: 'Body',
    });
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(INFRA_ALERT_OUTBOX_MAX_ATTEMPTS);
  });

  it('does not retry a failed fifth attempt', () => {
    getInfraDb()
      .prepare(
        `INSERT INTO infra_alert_outbox
           (id, project_id, alert_id, severity, transition_key, recipient_email,
            subject, body_text, status, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, NULL)`,
      )
      .run(
        'outbox-failed-fifth-attempt',
        'project-a',
        'alert-a',
        'critical',
        'alert-a:transition-2',
        'ops@example.com',
        'Alert',
        'Body',
        INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
      );

    expect(listRetryEligibleInfraAlertOutbox()).toHaveLength(0);
  });
});
