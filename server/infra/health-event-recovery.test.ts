import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

interface NotifyResult {
  broadcast: boolean;
  emailsQueued: number;
  emailEnqueueFailures: number;
}
const notifyInfraHealthEvent = vi.fn<(...args: unknown[]) => NotifyResult>(() => ({
  broadcast: true,
  emailsQueued: 0,
  emailEnqueueFailures: 0,
}));

// Fully replaced: the real module reaches `release-notification-settings.js`,
// which opens the main database. The fan-out itself has its own test file.
vi.mock('./health-event-notifications.js', () => ({
  notifyInfraHealthEvent: (...args: unknown[]) => notifyInfraHealthEvent(...args),
  buildHealthEventBroadcast: (row: { project_id: string; id: string }) => ({
    type: 'infra_health_event',
    projectId: row.project_id,
    healthEventId: row.id,
  }),
}));

const { initInfraDb, closeInfraDb } = await import('./infra-db.js');
const { recordInfraHealthEvents, listPendingInfraHealthEventNotifications } =
  await import('./health-event-store.js');
const { recoverPendingInfraHealthNotifications } = await import('./health-event-recovery.js');
type ParsedHealthEvent = import('./health-event-parse.js').ParsedHealthEvent;

let dir: string;
let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;

function event(overrides: Partial<ParsedHealthEvent> = {}): ParsedHealthEvent {
  return {
    eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
    communicationId: 'comm-1',
    affectedAccount: '123456789012',
    accountId: '123456789012',
    deliveryRegion: 'us-east-1',
    eventRegion: 'us-east-1',
    detailType: 'AWS Health Event',
    service: 'EC2',
    eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    eventScopeCode: 'PUBLIC',
    statusCode: 'open',
    severity: 'critical',
    startTimeMs: 1000,
    endTimeMs: null,
    lastUpdatedMs: null,
    description: null,
    affectedEntities: [],
    affectedEntityCount: 0,
    backupEvent: false,
    page: 1,
    totalPages: 1,
    eventTimeMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyInfraHealthEvent.mockReturnValue({
    broadcast: true,
    emailsQueued: 0,
    emailEnqueueFailures: 0,
  });
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-health-recovery-'));
  initInfraDb(dir);
  broadcast = vi.fn<(data: Record<string, unknown>) => void>();
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('recoverPendingInfraHealthNotifications', () => {
  it('re-fans-out an event whose notification never completed', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    const result = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(result).toEqual({ scanned: 1, recovered: 1, failed: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(listPendingInfraHealthEventNotifications('p1')).toHaveLength(0);
  });

  it('is a no-op on a second pass, so a recovered event is not re-notified', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    const second = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(second).toEqual({ scanned: 0, recovered: 0, failed: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('leaves a row pending when an email enqueue failed', () => {
    notifyInfraHealthEvent.mockReturnValue({
      broadcast: true,
      emailsQueued: 0,
      emailEnqueueFailures: 1,
    });
    recordInfraHealthEvents('p1', [event()], 1000);
    const result = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(result).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
    expect(listPendingInfraHealthEventNotifications('p1')).toHaveLength(1);
  });

  it('does not lose the rest of the batch when one event throws', () => {
    notifyInfraHealthEvent.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    recordInfraHealthEvents(
      'p1',
      [
        event({ eventArn: 'a1', communicationId: 'c1' }),
        event({ eventArn: 'a2', communicationId: 'c2' }),
      ],
      1000,
    );
    const result = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('sweeps each project independently', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    recordInfraHealthEvents('p2', [event()], 1000);
    const result = recoverPendingInfraHealthNotifications({
      projectIds: ['p1', 'p2'],
      broadcast,
    });
    expect(result.recovered).toBe(2);
  });

  it('never sweeps a deduped redelivery, because it was never pending', () => {
    // Dedupe and recovery are independent mechanisms; a duplicate does not
    // insert, so there is nothing for the sweep to find.
    recordInfraHealthEvents('p1', [event()], 1000);
    recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    recordInfraHealthEvents('p1', [event()], 2000);
    const second = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(second.scanned).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('skips the broadcast when routing suppressed it but still retires the row', () => {
    notifyInfraHealthEvent.mockReturnValue({
      broadcast: false,
      emailsQueued: 0,
      emailEnqueueFailures: 0,
    });
    recordInfraHealthEvents('p1', [event()], 1000);
    const result = recoverPendingInfraHealthNotifications({ projectIds: ['p1'], broadcast });
    expect(broadcast).not.toHaveBeenCalled();
    expect(result.recovered).toBe(1);
  });

  it('tolerates an empty project list', () => {
    expect(recoverPendingInfraHealthNotifications({ projectIds: [] })).toEqual({
      scanned: 0,
      recovered: 0,
      failed: 0,
    });
  });

  it('returns zeroes when the infra store is closed rather than throwing', () => {
    closeInfraDb();
    expect(recoverPendingInfraHealthNotifications({ projectIds: ['p1'] })).toEqual({
      scanned: 0,
      recovered: 0,
      failed: 0,
    });
    initInfraDb(dir);
  });
});
