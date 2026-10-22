/**
 * What the in-hub reviewer is told about dynamic test selection (wiki
 * `finalize-dynamic-test-selection-spec`, "Selection sources" 2). Only
 * projects in `testSelection.mode: dynamic` get this section; `full` projects
 * keep the plain review prompt and never see the selection fields.
 *
 * The reviewer reads the whole diff, so it can spot impact the session's own
 * test runs missed (HTTP contracts, client/server shapes, E2E flows). It can
 * only add to the selection: tests, whole jobs, or a forced full run.
 */
import type Database from 'better-sqlite3';
import type { CiConfig } from './ci-config-jobs.js';
import { sessionRanTestPaths, type SessionRanTestPath } from './session-ran-tests.js';
import type { TestSelectionPolicy } from './test-selection-policy.js';
import { selectionInstancesFor, type SelectionJobInstance } from './test-selection.js';
import {
  lookupTestInventory,
  type IsAncestorFn,
  type TestInventoryLookup,
} from './test-inventory.js';

export interface ReviewerSelectionInstance {
  jobId: string;
  matrixKey: string;
  /** Test files the inventory maps to this instance. */
  testFiles: string[];
}

export interface ReviewerSelectionContext {
  /** Test paths the session already ran; they are selected without the reviewer. */
  sessionRan: Array<Pick<SessionRanTestPath, 'path' | 'kind'>>;
  /** Jobs listed in `alwaysRun`. */
  alwaysRun: string[];
  /** Inventory state; anything but `ok` already forces a full run. */
  inventory:
    | { status: 'ok'; sha: string }
    | { status: 'stale'; reason: string }
    | { status: 'missing' };
  /** Every job instance of the CI config, with its inventoried test files. */
  instances: ReviewerSelectionInstance[];
}

/** Inventory files listed per instance before the prompt switches to counts. */
export const REVIEWER_INVENTORY_FILES_PER_INSTANCE = 40;
/** Total inventory files listed before the prompt switches to counts only. */
export const REVIEWER_INVENTORY_FILES_TOTAL = 400;
/** Session-ran paths listed before the rest are summarised. */
export const REVIEWER_SESSION_RAN_LIMIT = 100;

export function buildReviewerSelectionContext(args: {
  policy: TestSelectionPolicy;
  instances: SelectionJobInstance[];
  inventory: TestInventoryLookup;
  sessionRan: SessionRanTestPath[];
}): ReviewerSelectionContext {
  const files = new Map<string, string[]>();
  if (args.inventory.status === 'ok') {
    for (const e of args.inventory.entries) {
      const key = `${e.jobId}\u0000${e.matrixKey}`;
      const list = files.get(key);
      if (list) list.push(e.testFile);
      else files.set(key, [e.testFile]);
    }
  }
  const inventory: ReviewerSelectionContext['inventory'] =
    args.inventory.status === 'ok'
      ? { status: 'ok', sha: args.inventory.sha }
      : args.inventory.status === 'stale'
        ? { status: 'stale', reason: args.inventory.reason }
        : { status: 'missing' };
  return {
    sessionRan: args.sessionRan.map((r) => ({ path: r.path, kind: r.kind })),
    alwaysRun: [...args.policy.alwaysRun],
    inventory,
    instances: args.instances
      .filter((i) => !i.warmup)
      .map((i) => ({
        jobId: i.jobId,
        matrixKey: i.matrixKey,
        testFiles: [...(files.get(`${i.jobId}\u0000${i.matrixKey}`) ?? [])].sort(),
      })),
  };
}

/** DB + git: gather the reviewer's selection context for one review pass. */
export async function collectReviewerSelectionContext(args: {
  db: Database.Database;
  projectId: string;
  policy: TestSelectionPolicy;
  config: CiConfig;
  worktreePath: string;
  baseSha: string | null;
  headSha: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  isAncestor?: IsAncestorFn;
}): Promise<ReviewerSelectionContext> {
  const [inventory, sessionRan] = await Promise.all([
    args.baseSha
      ? lookupTestInventory(args.db, {
          projectId: args.projectId,
          baseSha: args.baseSha,
          repoDir: args.worktreePath,
          ...(args.isAncestor ? { isAncestor: args.isAncestor } : {}),
          ...(args.env ? { env: args.env } : {}),
        })
      : Promise.resolve<TestInventoryLookup>({ status: 'missing' }),
    sessionRanTestPaths({
      db: args.db,
      sessionId: args.sessionId,
      repoRoot: args.worktreePath,
      ref: args.headSha,
    }),
  ]);
  return buildReviewerSelectionContext({
    policy: args.policy,
    instances: selectionInstancesFor(args.config),
    inventory,
    sessionRan,
  });
}

function instanceLabel(i: Pick<ReviewerSelectionInstance, 'jobId' | 'matrixKey'>): string {
  return i.matrixKey ? `${i.jobId} [${i.matrixKey}]` : i.jobId;
}

/** Prompt section describing the selection and what the reviewer may add. */
export function renderReviewerSelectionSection(ctx: ReviewerSelectionContext): string {
  const lines: string[] = ['## Test selection (dynamic mode)', ''];
  lines.push(
    'This project runs only the CI job instances the change needs, not the whole',
    'suite. After you approve, the checks phase runs the instances that own the',
    'tests below plus anything you add. A full default-branch run after merge is',
    'the backstop, so a test missed here costs a red default branch.',
    '',
    'You can **only add** to the selection. You cannot remove a test the session',
    'ran or skip a job. Add a test when the diff can break it indirectly: an HTTP',
    'or WebSocket contract, a shape shared by client and server, a flow only an',
    'E2E test covers. Use `selection: "full"` when you cannot bound the impact.',
    '',
  );

  if (ctx.inventory.status !== 'ok') {
    const why =
      ctx.inventory.status === 'stale'
        ? `the test inventory is stale (${ctx.inventory.reason})`
        : 'no test inventory has been recorded yet';
    lines.push(`> This round already runs the full suite: ${why}.`, '');
  }

  lines.push('### Tests the session ran', '');
  if (ctx.sessionRan.length === 0) {
    lines.push('_(none detected in the session transcript)_');
  } else {
    for (const r of ctx.sessionRan.slice(0, REVIEWER_SESSION_RAN_LIMIT)) {
      lines.push(`- \`${r.path}${r.kind === 'dir' ? '/' : ''}\``);
    }
    if (ctx.sessionRan.length > REVIEWER_SESSION_RAN_LIMIT) {
      lines.push(`- _…and ${ctx.sessionRan.length - REVIEWER_SESSION_RAN_LIMIT} more_`);
    }
  }
  lines.push('');

  if (ctx.alwaysRun.length > 0) {
    lines.push(`Always run: ${ctx.alwaysRun.map((j) => `\`${j}\``).join(', ')}.`, '');
  }

  lines.push('### Job instances', '');
  const totalFiles = ctx.instances.reduce((n, i) => n + i.testFiles.length, 0);
  const listFiles = totalFiles <= REVIEWER_INVENTORY_FILES_TOTAL;
  for (const i of ctx.instances) {
    const count = i.testFiles.length;
    const suffix =
      ctx.inventory.status !== 'ok'
        ? ''
        : count === 0
          ? ' (no test inventory, always runs)'
          : ` (${count} test file${count === 1 ? '' : 's'})`;
    lines.push(`- \`${instanceLabel(i)}\`${suffix}`);
    if (listFiles && count > 0) {
      for (const f of i.testFiles.slice(0, REVIEWER_INVENTORY_FILES_PER_INSTANCE)) {
        lines.push(`  - \`${f}\``);
      }
      if (count > REVIEWER_INVENTORY_FILES_PER_INSTANCE) {
        lines.push(`  - _…and ${count - REVIEWER_INVENTORY_FILES_PER_INSTANCE} more_`);
      }
    }
  }
  if (!listFiles && ctx.inventory.status === 'ok') {
    lines.push(
      '',
      'The inventory is too large to list here. Name test files by their',
      'repo-relative path in the worktree; each maps to the shard that owns it.',
    );
  }
  lines.push(
    '',
    'A test file not in the inventory runs every shard of its job. An unknown job',
    'id, or a malformed `tests` / `jobs` / `selection` field, forces a full run.',
  );
  return lines.join('\n');
}

/** Extra verdict-block fields documented only for dynamic-mode projects. */
export const REVIEWER_SELECTION_OUTPUT_CONTRACT = `### Test selection fields (optional)

Add any of these keys to the same JSON object, next to \`verdict\` and \`threads\`:

\`\`\`
"tests": [{ "file": "client/src/api/sessions.test.ts", "reason": "response shape changed" }],
"jobs": [{ "job": "e2e", "reason": "login flow touched" }],
"selection": "full"
\`\`\`

- \`tests[].file\` is a repo-relative test file path; \`jobs[].job\` is a job id (\`e2e\`) to run every shard, or an instance label from the list above (\`e2e [shard]\`) to run one.
- \`selection\` accepts only \`"full"\`; when set, \`tests\` and \`jobs\` are ignored.
- Omit all three when the tests the session ran already cover the change.`;
