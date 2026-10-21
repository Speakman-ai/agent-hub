import { describe, expect, it } from 'vitest';
import {
  NOT_SELECTED_REASON,
  boardCardPath,
  defaultBranchHealthRefreshKey,
  defaultBranchRedLabel,
  findSelectionInstance,
  forcedFullLabel,
  readTestSelection,
  selectedRunLabel,
  selectionChipLabel,
  selectionInstanceName,
  selectionInstanceReason,
  sortedSelectionInstances,
  summarizeTestSelection,
} from './testSelectionDisplay';

const inst = (
  jobId: string,
  matrixKey: string,
  selected: boolean,
  extra: { sources?: string[]; reasons?: string[]; files?: string[] } = {},
) => ({
  jobId,
  matrixKey,
  selected,
  sources: extra.sources ?? [],
  files: extra.files ?? [],
  reasons: extra.reasons ?? [],
});

const selected = {
  mode: 'dynamic',
  forcedFullReason: null,
  inventorySha: 'abc',
  instances: [
    inst('lint', '', true, { sources: ['always'], reasons: ['listed in alwaysRun'] }),
    inst('server', 'shard=1', true, { sources: ['session'], files: ['server/a.test.ts'] }),
    inst('server', 'shard=2', false),
    inst('client', 'shard=1', false),
    inst('client', 'shard=2', false),
  ],
};

const forced = {
  ...selected,
  forcedFullReason: 'test inventory missing',
  instances: selected.instances.map((i) => ({ ...i, selected: true })),
};

describe('test selection display', () => {
  it('reads the manifest from every run payload shape', () => {
    expect(readTestSelection({ test_selection: JSON.stringify(selected) })?.instances).toHaveLength(
      5,
    );
    expect(readTestSelection({ test_selection: selected })?.inventorySha).toBe('abc');
    expect(readTestSelection({ testSelection: selected })?.mode).toBe('dynamic');
    expect(readTestSelection({ test_selection: null })).toBeNull();
    expect(readTestSelection({ test_selection: '{nope' })).toBeNull();
    expect(readTestSelection({ test_selection: { mode: 'full', instances: [] } })).toBeNull();
  });

  it('counts jobs, not instances: a job with any selected shard is selected', () => {
    expect(summarizeTestSelection(readTestSelection({ testSelection: selected })!)).toEqual({
      selectedJobs: 2,
      totalJobs: 3,
      selectedInstances: 2,
      totalInstances: 5,
      forcedFullReason: null,
    });
  });

  it('labels a selected run as Tested (selected: N of M jobs)', () => {
    expect(selectedRunLabel({ test_selection: JSON.stringify(selected) })).toBe(
      'Tested (selected: 2 of 3 jobs)',
    );
  });

  it('gives no selected badge for full, forced-full or fully-selected runs', () => {
    expect(selectedRunLabel({ test_selection: null })).toBeNull();
    expect(selectedRunLabel({ testSelection: forced })).toBeNull();
    const all = { ...selected, instances: forced.instances };
    expect(selectedRunLabel({ testSelection: all })).toBeNull();
    expect(selectionChipLabel(readTestSelection({ testSelection: all }))).toBe('all jobs selected');
  });

  it('shows the forced-full reason', () => {
    const s = readTestSelection({ testSelection: forced });
    expect(forcedFullLabel(s)).toBe('Full run: test inventory missing');
    expect(selectionChipLabel(s)).toBe('full run');
    expect(forcedFullLabel(readTestSelection({ testSelection: selected }))).toBeNull();
  });

  it('formats per-instance reasons', () => {
    const s = readTestSelection({ testSelection: selected })!;
    expect(selectionInstanceReason(s.instances[0])).toBe('listed in alwaysRun');
    expect(selectionInstanceReason(s.instances[1])).toBe('the session ran its tests');
    expect(selectionInstanceReason(s.instances[2])).toBe(NOT_SELECTED_REASON);
    expect(selectionInstanceName(s.instances[0])).toBe('lint');
    expect(selectionInstanceName(s.instances[1])).toBe('server · shard=1');
  });

  it('matches job rows to manifest entries, treating default as an empty key', () => {
    const s = readTestSelection({ testSelection: selected });
    expect(findSelectionInstance(s, 'lint', 'default')?.jobId).toBe('lint');
    expect(findSelectionInstance(s, 'server', 'shard=2')?.selected).toBe(false);
    expect(findSelectionInstance(s, 'server', 'shard=9')).toBeNull();
    expect(findSelectionInstance(null, 'lint', '')).toBeNull();
  });

  it('sorts selected instances first', () => {
    const names = sortedSelectionInstances(readTestSelection({ testSelection: selected })!).map(
      selectionInstanceName,
    );
    expect(names).toEqual([
      'lint',
      'server · shard=1',
      'client · shard=1',
      'client · shard=2',
      'server · shard=2',
    ]);
  });
});

describe('default-branch health display', () => {
  const failure = {
    job_id: 'server',
    matrix_key: 'shard=1',
    first_failing_sha: 'a',
    last_failing_sha: 'b',
  };

  it('labels a red branch with its failing instance count', () => {
    expect(
      defaultBranchRedLabel({ state: 'red', branch: 'main', breakage: null, failures: [failure] }),
    ).toBe('main is red: 1 failing instance');
    expect(
      defaultBranchRedLabel({
        state: 'red',
        branch: 'main',
        breakage: null,
        failures: [failure, { ...failure, matrix_key: 'shard=2' }],
      }),
    ).toBe('main is red: 2 failing instances');
  });

  it('returns null unless the branch is red', () => {
    expect(defaultBranchRedLabel(null)).toBeNull();
    expect(
      defaultBranchRedLabel({ state: 'green', branch: 'main', breakage: null, failures: [] }),
    ).toBeNull();
  });

  it('builds a board deep link only with a card id', () => {
    expect(boardCardPath('agent hub', 'c/1')).toBe('/projects/agent%20hub/board?card=c%2F1');
    expect(boardCardPath('p', null)).toBeNull();
  });
});

describe('defaultBranchHealthRefreshKey', () => {
  it('tracks only push-CI runs and changes with their status', () => {
    const runs = [
      { id: 'a', trigger_source: 'git_push', status: 'running' },
      { id: 's', trigger_source: 'ui_button', status: 'running' },
    ];
    const before = defaultBranchHealthRefreshKey(runs);
    expect(before).toBe('a:running');
    expect(defaultBranchHealthRefreshKey([{ ...runs[0], status: 'failed' }, runs[1]])).not.toBe(
      before,
    );
    expect(defaultBranchHealthRefreshKey([runs[0], { ...runs[1], status: 'failed' }])).toBe(before);
    expect(defaultBranchHealthRefreshKey(null)).toBe('');
  });
});
