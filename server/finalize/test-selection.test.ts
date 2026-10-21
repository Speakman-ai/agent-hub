import { describe, expect, it, vi } from 'vitest';
import { parseCiConfig } from './ci-config.js';
import type { TestInventoryEntry, TestInventoryLookup } from './test-inventory.js';
import { resolveTestSelectionPolicy } from './test-selection-policy.js';
import {
  computeTestSelection,
  isDocPath,
  notSelectedInstanceKeys,
  parseNameStatusZ,
  resolveTestSelection,
  selectionInstancesFor,
  type ChangedPath,
  type ComputeTestSelectionInput,
  type SelectionJobInstance,
  type TestSelection,
} from './test-selection.js';
import { jobInstanceKey } from './base-drift-policy.js';
import type { SessionRanTestPath } from './session-ran-tests.js';

const INSTANCES: SelectionJobInstance[] = [
  { jobId: 'lint', matrixKey: '', needs: [], warmup: false },
  { jobId: 'server', matrixKey: 'group=1', needs: [], warmup: false },
  { jobId: 'server', matrixKey: 'group=2', needs: [], warmup: false },
  { jobId: 'client', matrixKey: '', needs: [], warmup: false },
  { jobId: 'e2e', matrixKey: '', needs: ['build'], warmup: false },
  { jobId: 'build', matrixKey: '', needs: ['deps'], warmup: false },
  { jobId: 'deps', matrixKey: '', needs: [], warmup: false },
];

const ENTRIES: TestInventoryEntry[] = [
  { jobId: 'server', matrixKey: 'group=1', testFile: 'server/a.test.ts' },
  { jobId: 'server', matrixKey: 'group=2', testFile: 'server/b.test.ts' },
  { jobId: 'server', matrixKey: 'group=2', testFile: 'server/routes/c.test.ts' },
  { jobId: 'client', matrixKey: '', testFile: 'client/src/x.test.tsx' },
  { jobId: 'e2e', matrixKey: '', testFile: 'e2e/tests/login.spec.ts' },
  { jobId: 'lint', matrixKey: '', testFile: 'scripts/lint.test.ts' },
  { jobId: 'build', matrixKey: '', testFile: 'scripts/build/build.test.ts' },
  { jobId: 'deps', matrixKey: '', testFile: 'scripts/deps/deps.test.ts' },
];

const OK: TestInventoryLookup = {
  status: 'ok',
  sha: 'inv123',
  branch: 'main',
  recordedAt: 1,
  entries: ENTRIES,
};

function ran(p: string, kind: 'file' | 'dir' = 'file'): SessionRanTestPath {
  return { path: p, kind, runner: 'vitest' };
}

function input(over: Partial<ComputeTestSelectionInput> = {}): ComputeTestSelectionInput {
  return {
    policy: resolveTestSelectionPolicy({ mode: 'dynamic' }),
    instances: INSTANCES,
    inventory: OK,
    changed: [{ status: 'M', path: 'server/a.ts' }],
    sessionRan: [ran('server/a.test.ts')],
    reviewer: { kind: 'none' },
    ...over,
  };
}

function selectedKeys(sel: TestSelection): string[] {
  return sel.instances
    .filter((i) => i.selected)
    .map((i) => (i.matrixKey ? `${i.jobId}/${i.matrixKey}` : i.jobId))
    .sort();
}

function expectFull(sel: TestSelection, reason: RegExp): void {
  expect(sel.forcedFullReason).toMatch(reason);
  expect(sel.instances.every((i) => i.selected)).toBe(true);
  expect(notSelectedInstanceKeys(sel).size).toBe(0);
}

describe('computeTestSelection', () => {
  it('runs only the instance owning a test the session ran', () => {
    const sel = computeTestSelection(input());
    expect(sel.forcedFullReason).toBeNull();
    expect(sel.inventorySha).toBe('inv123');
    expect(selectedKeys(sel)).toEqual(['server/group=1']);
    const inst = sel.instances.find((i) => i.matrixKey === 'group=1')!;
    expect(inst.sources).toEqual(['session']);
    expect(inst.files).toEqual(['server/a.test.ts']);
    expect([...notSelectedInstanceKeys(sel)]).toContain(jobInstanceKey('client', ''));
  });

  it('adds alwaysRun jobs and jobs with no inventory', () => {
    const sel = computeTestSelection(
      input({
        policy: resolveTestSelectionPolicy({ mode: 'dynamic', alwaysRun: ['lint'] }),
        instances: [...INSTANCES, { jobId: 'typecheck', matrixKey: '', needs: [], warmup: false }],
      }),
    );
    expect(selectedKeys(sel)).toEqual(['lint', 'server/group=1', 'typecheck']);
    expect(sel.instances.find((i) => i.jobId === 'typecheck')!.reasons).toEqual([
      'job has no test inventory',
    ]);
  });

  it('pulls in the transitive needs: closure of a selected job', () => {
    const sel = computeTestSelection(input({ sessionRan: [ran('e2e/tests/login.spec.ts')] }));
    expect(selectedKeys(sel)).toEqual(['build', 'deps', 'e2e']);
    expect(sel.instances.find((i) => i.jobId === 'deps')!.sources).toEqual(['needs']);
  });

  it('runs warmup jobs only when another job runs', () => {
    const instances = [...INSTANCES, { jobId: 'warm', matrixKey: '', needs: [], warmup: true }];
    const entries = [...ENTRIES, { jobId: 'warm', matrixKey: '', testFile: 'w/w.test.ts' }];
    const inventory = { ...OK, entries };
    expect(selectedKeys(computeTestSelection(input({ instances, inventory })))).toContain('warm');
    const docsOnly = computeTestSelection(
      input({
        instances,
        inventory,
        changed: [{ status: 'M', path: 'README.md' }],
        sessionRan: [],
      }),
    );
    expect(selectedKeys(docsOnly)).toEqual([]);
  });

  it('selects every inventoried test under a directory the session ran', () => {
    const sel = computeTestSelection(input({ sessionRan: [ran('server', 'dir')] }));
    expect(selectedKeys(sel)).toEqual(['server/group=1', 'server/group=2']);
  });

  it('maps a Go package dir to its import path', () => {
    const inventory = {
      ...OK,
      entries: [
        ...ENTRIES,
        { jobId: 'client', matrixKey: '', testFile: 'example.com/mod/pkg/util' },
      ],
    };
    const sel = computeTestSelection(
      input({ inventory, sessionRan: [{ path: 'pkg/util', kind: 'dir', runner: 'go' }] }),
    );
    expect(selectedKeys(sel)).toEqual(['client']);
  });

  it('adds reviewer jobs and tests', () => {
    const sel = computeTestSelection(
      input({
        reviewer: {
          kind: 'additions',
          jobs: [{ job: 'client', reason: 'shape change' }],
          tests: [{ file: 'server/b.test.ts' }],
        },
      }),
    );
    expect(selectedKeys(sel)).toEqual(['client', 'server/group=1', 'server/group=2']);
    expect(sel.instances.find((i) => i.jobId === 'client')!.reasons).toEqual(['shape change']);
  });

  it('runs a test file the diff edits', () => {
    const sel = computeTestSelection(
      input({ changed: [{ status: 'M', path: 'client/src/x.test.tsx' }], sessionRan: [] }),
    );
    expect(selectedKeys(sel)).toEqual(['client']);
  });

  describe('file ownership', () => {
    it('runs every instance of the job owning the directory of a file new to the inventory', () => {
      const sel = computeTestSelection(input({ sessionRan: [ran('server/new.test.ts')] }));
      expect(selectedKeys(sel)).toEqual(['server/group=1', 'server/group=2']);
      expect(sel.instances.find((i) => i.jobId === 'server')!.sources).toEqual(['unmapped']);
    });

    it('forces a full run when no job owns the directory', () => {
      expectFull(
        computeTestSelection(input({ sessionRan: [ran('nowhere/z.test.ts')] })),
        /no owning job/,
      );
    });

    it('forces a full run when several jobs own the directory', () => {
      const inventory = {
        ...OK,
        entries: [
          ...ENTRIES,
          { jobId: 'client', matrixKey: '', testFile: 'server/shared.test.ts' },
        ],
      };
      expectFull(
        computeTestSelection(input({ inventory, sessionRan: [ran('server/new.test.ts')] })),
        /several jobs: client, server/,
      );
    });

    it.each([
      ['added', { status: 'A', path: 'server/routes/d.test.ts' }],
      ['deleted', { status: 'D', path: 'server/b.test.ts' }],
      ['renamed', { status: 'R', oldPath: 'server/b.test.ts', path: 'server/bb.test.ts' }],
    ] as Array<[string, ChangedPath]>)(
      'runs every instance of the owning job for a %s test file',
      (_, change) => {
        const sel = computeTestSelection(
          input({ changed: [change], sessionRan: [ran('client/src/x.test.tsx')] }),
        );
        expect(selectedKeys(sel)).toEqual(['client', 'server/group=1', 'server/group=2']);
      },
    );
  });

  describe('forced full runs', () => {
    it('on a fullRunPaths match, including project globs', () => {
      expectFull(
        computeTestSelection(input({ changed: [{ status: 'M', path: 'server/package.json' }] })),
        /fullRunPaths: server\/package.json/,
      );
      const policy = resolveTestSelectionPolicy({ mode: 'dynamic', fullRunPaths: ['shared/**'] });
      expectFull(
        computeTestSelection(input({ policy, changed: [{ status: 'M', path: 'shared/x.ts' }] })),
        /fullRunPaths/,
      );
    });

    it('on a rename whose old path matches fullRunPaths', () => {
      expectFull(
        computeTestSelection(
          input({ changed: [{ status: 'R', oldPath: 'Dockerfile', path: 'docker/app.txt' }] }),
        ),
        /Dockerfile/,
      );
    });

    it('when the reviewer asks for one (selection: full, timeout or a bad block)', () => {
      expectFull(
        computeTestSelection(input({ reviewer: { kind: 'full', reason: 'reviewer timed out' } })),
        /reviewer timed out/,
      );
    });

    it('when the reviewer names an unknown job', () => {
      expectFull(
        computeTestSelection(
          input({ reviewer: { kind: 'additions', jobs: [{ job: 'nope' }], tests: [] } }),
        ),
        /unknown job "nope"/,
      );
    });

    it('when the inventory is missing or stale', () => {
      expectFull(
        computeTestSelection(input({ inventory: { status: 'missing' } })),
        /no test inventory/,
      );
      expectFull(
        computeTestSelection(
          input({
            inventory: {
              status: 'stale',
              sha: 'old',
              branch: 'main',
              recordedAt: 1,
              reason: 'not an ancestor',
            },
          }),
        ),
        /stale: not an ancestor/,
      );
    });

    it('when the inventory names an instance the CI config lacks', () => {
      const inventory = {
        ...OK,
        entries: [
          ...ENTRIES,
          { jobId: 'server', matrixKey: 'group=3', testFile: 'server/z.test.ts' },
        ],
      };
      expectFull(computeTestSelection(input({ inventory })), /server\/group=3/);
    });

    it('when nothing is selected for a code change', () => {
      expectFull(computeTestSelection(input({ sessionRan: [] })), /no test was selected/);
    });

    it('but not when the change only touches docs', () => {
      const sel = computeTestSelection(
        input({
          policy: resolveTestSelectionPolicy({ mode: 'dynamic', alwaysRun: ['lint'] }),
          changed: [
            { status: 'M', path: 'docs/guide.md' },
            { status: 'A', path: 'CHANGELOG' },
          ],
          sessionRan: [],
        }),
      );
      expect(sel.forcedFullReason).toBeNull();
      expect(selectedKeys(sel)).toEqual(['lint']);
    });

    it('when code under docs/ changes with nothing selected', () => {
      for (const path of ['docs/site/components/Search.tsx', 'docs/build.mjs', 'docs/page.mdx']) {
        expectFull(
          computeTestSelection(input({ changed: [{ status: 'M', path }], sessionRan: [] })),
          /no test was selected/,
        );
      }
    });

    it('isDocPath classifies by file type, not directory', () => {
      expect(isDocPath('docs/guide.md')).toBe(true);
      expect(isDocPath('server/README.md')).toBe(true);
      expect(isDocPath('LICENSE')).toBe(true);
      expect(isDocPath('docs/site/components/Search.tsx')).toBe(false);
      expect(isDocPath('docs/api/openapi.yaml')).toBe(false);
      expect(isDocPath('docs/page.mdx')).toBe(false);
      expect(isDocPath('LICENSE.js')).toBe(false);
    });

    it('when a session-ran directory has no inventoried test', () => {
      expectFull(
        computeTestSelection(input({ sessionRan: [ran('tools', 'dir')] })),
        /tools\/, which has no test/,
      );
    });

    it('on any selection error', async () => {
      const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  unit:
    runs-on: host
    steps:
      - run: echo unit
`);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const sel = await resolveTestSelection({
        db: {} as never,
        projectId: 'p',
        policy: resolveTestSelectionPolicy({ mode: 'dynamic' }),
        config: parsed.config,
        worktreePath: '/tmp/wt',
        baseSha: 'base',
        headSha: 'head',
        sessionId: 's',
        reviewer: { kind: 'none' },
        previous: null,
        listChangedPaths: vi.fn().mockRejectedValue(new Error('git exploded')),
        listSessionRanTests: vi.fn().mockResolvedValue([]),
      });
      expectFull(sel, /selection error: git exploded/);
      expect(sel.instances.map((i) => i.jobId)).toEqual(['unit']);
    });

    it('when the round base is unknown', async () => {
      const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  unit:
    runs-on: host
    steps:
      - run: echo unit
`);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const sel = await resolveTestSelection({
        db: {} as never,
        projectId: 'p',
        policy: resolveTestSelectionPolicy({ mode: 'dynamic' }),
        config: parsed.config,
        worktreePath: '/tmp/wt',
        baseSha: null,
        headSha: 'head',
        sessionId: 's',
        reviewer: { kind: 'none' },
        previous: null,
      });
      expectFull(sel, /base commit/);
    });
  });

  describe('across rounds', () => {
    it('keeps the previous selection and only grows it', () => {
      const first = computeTestSelection(input());
      const second = computeTestSelection(
        input({ sessionRan: [ran('client/src/x.test.tsx')], previous: first }),
      );
      expect(selectedKeys(second)).toEqual(['client', 'server/group=1']);
      const server = second.instances.find((i) => i.matrixKey === 'group=1')!;
      expect(server.files).toEqual(['server/a.test.ts']);
    });

    it('stays full once a round forced a full run', () => {
      const first = computeTestSelection(input({ inventory: { status: 'missing' } }));
      const second = computeTestSelection(input({ previous: first }));
      expectFull(second, /no test inventory/);
    });

    it('grows to full when a later round forces one', () => {
      const first = computeTestSelection(input());
      const second = computeTestSelection(
        input({ previous: first, changed: [{ status: 'M', path: 'yarn.lock' }] }),
      );
      expectFull(second, /yarn.lock/);
    });
  });
});

describe('parseNameStatusZ', () => {
  it('parses plain, rename and copy entries', () => {
    const out = parseNameStatusZ('M\0a.ts\0R087\0old.ts\0new.ts\0C100\0x.ts\0y.ts\0D\0gone.ts\0');
    expect(out).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', oldPath: 'old.ts', path: 'new.ts' },
      { status: 'C', oldPath: 'x.ts', path: 'y.ts' },
      { status: 'D', path: 'gone.ts' },
    ]);
  });

  it('throws on truncated output', () => {
    expect(() => parseNameStatusZ('R100\0old.ts\0')).toThrow(/truncated/);
  });
});

describe('selectionInstancesFor', () => {
  it('expands matrix shards with their needs', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: host
    steps:
      - run: echo build
  test:
    runs-on: host
    needs: [build]
    matrix:
      include:
        - group: "1"
        - group: "2"
    steps:
      - run: echo test
`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const out = selectionInstancesFor(parsed.config);
    expect(out.map((i) => [i.jobId, i.needs])).toEqual([
      ['build', []],
      ['test', ['build']],
      ['test', ['build']],
    ]);
    expect(new Set(out.map((i) => i.matrixKey)).size).toBe(3);
  });
});
