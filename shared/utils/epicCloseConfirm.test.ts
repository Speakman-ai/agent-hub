import { describe, expect, it } from 'vitest';
import { bulkEpicCloseConfirmMessage, epicCloseConfirmMessage } from './epicCloseConfirm.js';

const epic = { id: 'e1', name: 'Checkout' };
const worker = { sessionId: 's1', sessionName: 'w', cardId: 'c1', cardTitle: 'Card' };

describe('epicCloseConfirmMessage', () => {
  it('asks when the epic has running workers and names the count', () => {
    expect(
      epicCloseConfirmMessage({ epic, runningWorkers: [worker], runningWorkerCount: 1 }),
    ).toContain('"Checkout"');
    expect(
      epicCloseConfirmMessage({ epic, runningWorkers: [worker, worker], runningWorkerCount: 2 }),
    ).toContain('2 running worker sessions');
    expect(
      epicCloseConfirmMessage({ epic, runningWorkers: [worker], runningWorkerCount: 1 }),
    ).toContain('1 running worker session.');
  });

  it('skips the prompt with no epic or no running workers', () => {
    expect(epicCloseConfirmMessage(null)).toBeNull();
    expect(
      epicCloseConfirmMessage({ epic: null, runningWorkers: [], runningWorkerCount: 0 }),
    ).toBeNull();
    expect(epicCloseConfirmMessage({ epic, runningWorkers: [], runningWorkerCount: 0 })).toBeNull();
  });
});

describe('bulkEpicCloseConfirmMessage', () => {
  it('sums workers across the epics a bulk archive stops', () => {
    const msg = bulkEpicCloseConfirmMessage({
      epics: [epic, { id: 'e2', name: 'Search' }],
      runningWorkers: [worker, worker, worker],
      runningWorkerCount: 3,
    });
    expect(msg).toContain('"Checkout", "Search"');
    expect(msg).toContain('3 running worker sessions');
  });

  it('skips the prompt when nothing running would stop', () => {
    expect(bulkEpicCloseConfirmMessage(null)).toBeNull();
    expect(
      bulkEpicCloseConfirmMessage({ epics: [epic], runningWorkers: [], runningWorkerCount: 0 }),
    ).toBeNull();
    expect(
      bulkEpicCloseConfirmMessage({ epics: [], runningWorkers: [], runningWorkerCount: 0 }),
    ).toBeNull();
  });
});
