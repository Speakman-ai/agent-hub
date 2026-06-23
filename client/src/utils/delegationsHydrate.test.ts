import { describe, it, expect } from 'vitest';
import { mapDelegationRowsToLiveShape } from './delegationsHydrate';

describe('mapDelegationRowsToLiveShape', () => {
  it('returns null when given null, undefined, or an empty array', () => {
    expect(mapDelegationRowsToLiveShape(null)).toBeNull();
    expect(mapDelegationRowsToLiveShape(undefined)).toBeNull();
    expect(mapDelegationRowsToLiveShape([])).toBeNull();
  });

  it('returns null when given a non-array (defensive)', () => {
    expect(mapDelegationRowsToLiveShape({ tasks: [] })).toBeNull();
    expect(mapDelegationRowsToLiveShape('rows')).toBeNull();
    expect(mapDelegationRowsToLiveShape(42)).toBeNull();
  });

  it('converts snake_case DB rows into the live-shape consumed by DelegateCard', () => {
    const rows = [
      {
        id: 'd1',
        session_id: 's1',
        parent_message_id: 'm-recent',
        agent_id: 'hub-frontend',
        agent_name: 'Hub Frontend',
        task: 'implement the UI',
        status: 'done',
        output: 'shipped commit abc',
        error: null,
        started_at: '2026-04-27T10:00:00Z',
      },
      {
        id: 'd0',
        session_id: 's1',
        parent_message_id: 'm-older',
        agent_id: 'hub-backend',
        agent_name: 'Hub Backend',
        task: 'wire the API',
        status: 'error',
        output: null,
        error: 'Exited with code 1',
        started_at: '2026-04-26T08:00:00Z',
      },
    ];
    const shaped = mapDelegationRowsToLiveShape(rows);
    expect(shaped!).not.toBeNull();
    expect(shaped!.parentMessageId).toBe('m-recent');
    expect(shaped!.tasks).toHaveLength(2);
    expect(shaped!.tasks[0]).toEqual({
      delegationId: 'd1',
      agentId: 'hub-frontend',
      agentName: 'Hub Frontend',
      agentColor: null,
      task: 'implement the UI',
      status: 'done',
      content: '',
      output: 'shipped commit abc',
      error: null,
      startedAt: '2026-04-27T10:00:00Z',
    });
    expect(shaped!.tasks[1]).toEqual({
      delegationId: 'd0',
      agentId: 'hub-backend',
      agentName: 'Hub Backend',
      agentColor: null,
      task: 'wire the API',
      status: 'error',
      content: '',
      output: null,
      error: 'Exited with code 1',
      startedAt: '2026-04-26T08:00:00Z',
    });
  });

  it('also accepts pre-camelCased rows (forward-compatible with future API)', () => {
    const shaped = mapDelegationRowsToLiveShape([
      {
        id: 'd1',
        parentMessageId: 'm1',
        agentId: 'hub-frontend',
        agentName: 'Hub Frontend',
        task: 't',
        status: 'running',
        startedAt: '2026-04-27T10:00:00Z',
      },
    ]);
    expect(shaped!.parentMessageId).toBe('m1');
    expect(shaped!.tasks[0].agentId).toBe('hub-frontend');
    expect(shaped!.tasks[0].agentName).toBe('Hub Frontend');
    expect(shaped!.tasks[0].status).toBe('running');
  });

  it('drops malformed rows that lack an agentId rather than throwing', () => {
    const shaped = mapDelegationRowsToLiveShape([
      null,
      undefined,
      'not an object',
      { agent_id: '' },
      { task: 'orphaned with no agent' },
      {
        id: 'd1',
        agent_id: 'hub-frontend',
        agent_name: 'Hub Frontend',
        task: 'go',
        status: 'done',
      },
    ]);
    expect(shaped!.tasks).toHaveLength(1);
    expect(shaped!.tasks[0].agentId).toBe('hub-frontend');
  });

  it('returns null when every row is malformed', () => {
    expect(mapDelegationRowsToLiveShape([null, { task: 'no agent' }, { agent_id: '' }])).toBeNull();
  });

  it('falls back to agent_id for agentName when name is missing/empty', () => {
    const shaped = mapDelegationRowsToLiveShape([
      { id: 'd1', agent_id: 'ghost', agent_name: '', task: 't', status: 'done' },
      { id: 'd2', agent_id: 'wraith', task: 't2', status: 'done' },
    ]);
    expect(shaped!.tasks[0].agentName).toBe('ghost');
    expect(shaped!.tasks[1].agentName).toBe('wraith');
  });

  it('defaults missing status to "pending" so DelegateCard renders the Pending badge (not the Queued placeholder)', () => {
    const shaped = mapDelegationRowsToLiveShape([
      { id: 'd1', agent_id: 'hub-frontend', task: 'go' },
    ]);
    expect(shaped!.tasks[0].status).toBe('pending');
  });

  it('keeps the most recent parentMessageId — DB returns started_at DESC so row[0] is newest', () => {
    const shaped = mapDelegationRowsToLiveShape([
      { id: 'd2', parent_message_id: 'm-newest', agent_id: 'a', task: 't', status: 'running' },
      { id: 'd1', parent_message_id: 'm-old', agent_id: 'b', task: 't', status: 'done' },
    ]);
    expect(shaped!.parentMessageId).toBe('m-newest');
  });

  it('tolerates rows where parent_message_id is absent on the newest entry', () => {
    const shaped = mapDelegationRowsToLiveShape([
      { id: 'd2', agent_id: 'a', task: 't', status: 'running' },
      { id: 'd1', parent_message_id: 'm-old', agent_id: 'b', task: 't', status: 'done' },
    ]);
    // Walks forward to the first row that does have one rather than locking
    // null in — the older round is at least better than nothing.
    expect(shaped!.parentMessageId).toBe('m-old');
  });
});
