import { describe, expect, it } from 'vitest';
import {
  REVIEWER_INVENTORY_FILES_TOTAL,
  buildReviewerSelectionContext,
  renderReviewerSelectionSection,
} from './reviewer-selection-context.js';
import { resolveTestSelectionPolicy } from './test-selection-policy.js';

const policy = resolveTestSelectionPolicy({ mode: 'dynamic', alwaysRun: ['lint'] });
const instances = [
  { jobId: 'lint', matrixKey: '', needs: [], warmup: false },
  { jobId: 'server', matrixKey: 'shard=1', needs: [], warmup: false },
  { jobId: 'server', matrixKey: 'shard=2', needs: [], warmup: false },
  { jobId: 'warm', matrixKey: '', needs: [], warmup: true },
];
const inventory = {
  status: 'ok' as const,
  sha: 'abc',
  branch: 'main',
  recordedAt: 1,
  entries: [
    { jobId: 'server', matrixKey: 'shard=1', testFile: 'server/b.test.ts' },
    { jobId: 'server', matrixKey: 'shard=1', testFile: 'server/a.test.ts' },
    { jobId: 'server', matrixKey: 'shard=2', testFile: 'server/c.test.ts' },
  ],
};

describe('buildReviewerSelectionContext', () => {
  it('groups inventory files by instance and drops warmup jobs', () => {
    const ctx = buildReviewerSelectionContext({
      policy,
      instances,
      inventory,
      sessionRan: [{ path: 'server/a.test.ts', kind: 'file', runner: 'vitest' }],
    });
    expect(ctx.instances).toEqual([
      { jobId: 'lint', matrixKey: '', testFiles: [] },
      {
        jobId: 'server',
        matrixKey: 'shard=1',
        testFiles: ['server/a.test.ts', 'server/b.test.ts'],
      },
      { jobId: 'server', matrixKey: 'shard=2', testFiles: ['server/c.test.ts'] },
    ]);
    expect(ctx.sessionRan).toEqual([{ path: 'server/a.test.ts', kind: 'file' }]);
    expect(ctx.alwaysRun).toEqual(['lint']);
    expect(ctx.inventory).toEqual({ status: 'ok', sha: 'abc' });
  });
});

describe('renderReviewerSelectionSection', () => {
  it('lists the session-ran tests and the job inventory and says it can only add', () => {
    const out = renderReviewerSelectionSection(
      buildReviewerSelectionContext({
        policy,
        instances,
        inventory,
        sessionRan: [{ path: 'client/src/api', kind: 'dir', runner: 'vitest' }],
      }),
    );
    expect(out).toContain('## Test selection (dynamic mode)');
    expect(out).toContain('**only add**');
    expect(out).toContain('- `client/src/api/`');
    expect(out).toContain('- `server [shard=1]` (2 test files)');
    expect(out).toContain('  - `server/c.test.ts`');
    expect(out).toContain('- `lint` (no test inventory, always runs)');
    expect(out).toContain('Always run: `lint`.');
    expect(out).not.toContain('warm');
  });

  it('says the round already runs in full when the inventory is missing', () => {
    const out = renderReviewerSelectionSection(
      buildReviewerSelectionContext({
        policy,
        instances,
        inventory: { status: 'missing' },
        sessionRan: [],
      }),
    );
    expect(out).toContain('already runs the full suite: no test inventory');
    expect(out).toContain('_(none detected in the session transcript)_');
    expect(out).toContain('- `server [shard=1]`\n');
  });

  it('switches to counts when the inventory is too large to list', () => {
    const entries = Array.from({ length: REVIEWER_INVENTORY_FILES_TOTAL + 1 }, (_, n) => ({
      jobId: 'server',
      matrixKey: 'shard=1',
      testFile: `server/t${n}.test.ts`,
    }));
    const out = renderReviewerSelectionSection(
      buildReviewerSelectionContext({
        policy,
        instances,
        inventory: { ...inventory, entries },
        sessionRan: [],
      }),
    );
    expect(out).toContain(`(${REVIEWER_INVENTORY_FILES_TOTAL + 1} test files)`);
    expect(out).not.toContain('server/t0.test.ts');
    expect(out).toContain('too large to list');
  });
});
