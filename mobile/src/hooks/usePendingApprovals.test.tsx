import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

const testState = vi.hoisted(() => ({ api: { listMyApprovals: vi.fn() } }));
vi.mock('../utils/api', () => ({ api: testState.api }));

const { usePendingApprovals } = await import('./usePendingApprovals');
const { approvalEvents } = await import('../utils/approvalEvents');

function approval(id: string, sessionId = 's1') {
  return { id, sessionId, status: 'pending', requestedAt: 1, canRemember: false };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let latest: ReturnType<typeof usePendingApprovals>;
function Probe({ sessionId }: { sessionId: string | null }) {
  latest = usePendingApprovals({ sessionId });
  return null;
}

async function flush() {
  await TestRenderer.act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function mount(sessionId: string | null) {
  let r!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    r = TestRenderer.create(<Probe sessionId={sessionId} />);
  });
  await flush();
  return r;
}

const ids = () => latest.pending.map((a) => a.id);

describe('usePendingApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.api.listMyApprovals.mockResolvedValue({ approvals: [approval('ap1')] });
  });

  it("hides the previous session's approvals while the next session's list loads", async () => {
    const r = await mount('s1');
    expect(ids()).toEqual(['ap1']);
    const slow = deferred<{ approvals: unknown[] }>();
    testState.api.listMyApprovals.mockReturnValueOnce(slow.promise);
    await TestRenderer.act(async () => {
      r.update(<Probe sessionId="s2" />);
    });
    expect(ids()).toEqual([]);
    await TestRenderer.act(async () => {
      slow.resolve({ approvals: [approval('ap2', 's2')] });
    });
    await flush();
    expect(ids()).toEqual(['ap2']);
  });

  it('a list response in flight when the approval resolves does not restore it', async () => {
    testState.api.listMyApprovals.mockResolvedValueOnce({ approvals: [] });
    await mount('s1');
    const late = deferred<{ approvals: unknown[] }>();
    testState.api.listMyApprovals.mockReturnValueOnce(late.promise);
    await TestRenderer.act(async () => {
      approvalEvents.emit({ type: 'approval_requested', sessionId: 's1' });
      approvalEvents.emit({ type: 'approval_resolved', sessionId: 's1', approvalId: 'ap1' });
    });
    await TestRenderer.act(async () => {
      late.resolve({ approvals: [approval('ap1')] });
    });
    await flush();
    expect(ids()).toEqual([]);
  });

  it('a list response in flight when the user answers does not restore it', async () => {
    await mount('s1');
    const late = deferred<{ approvals: unknown[] }>();
    testState.api.listMyApprovals.mockReturnValueOnce(late.promise);
    await TestRenderer.act(async () => {
      approvalEvents.emit({ type: 'approval_requested', sessionId: 's1' });
      latest.drop('ap1');
    });
    expect(ids()).toEqual([]);
    await TestRenderer.act(async () => {
      late.resolve({ approvals: [approval('ap1')] });
    });
    await flush();
    expect(ids()).toEqual([]);
  });

  it('returns nothing without a session', async () => {
    await mount(null);
    expect(ids()).toEqual([]);
    expect(testState.api.listMyApprovals).not.toHaveBeenCalled();
  });
});
