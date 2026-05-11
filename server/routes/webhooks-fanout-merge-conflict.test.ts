import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecFileOptions } from 'child_process';

// Mock child_process so the test never shells out to a real `gh` binary.
// We carefully preserve util.promisify.custom on the execFile mock so that
// `promisify(execFile)` (the form used inside webhooks.ts) resolves to the
// documented `{ stdout, stderr }` shape rather than the generic raw-stdout
// fallback. Without this, destructuring `const { stdout } = await
// execFileAsync(...)` blows up.
type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;
type GhCall = { args: string[]; opts?: ExecFileOptions };

const ghCalls: GhCall[] = [];
let ghHandler: (args: string[]) => { stdout: string; stderr?: string } | Error = () => ({
  stdout: '',
});

vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('child_process');
  const { promisify } = await import('util');
  const customSym = (promisify as unknown as { custom: symbol }).custom;

  // The plain callback-style execFile mock — required so the runtime
  // shape of `child_process.execFile` stays callable in case any code
  // uses it without promisify.
  const execFile = (
    _file: string,
    args: string[],
    opts: ExecFileOptions | ExecFileCb,
    maybeCb?: ExecFileCb,
  ) => {
    const cb = (typeof opts === 'function' ? opts : maybeCb) as ExecFileCb;
    const realOpts = typeof opts === 'function' ? undefined : opts;
    ghCalls.push({ args: [...args], opts: realOpts });
    const res = ghHandler(args);
    if (res instanceof Error) cb(res, { stdout: '', stderr: '' });
    else cb(null, { stdout: res.stdout, stderr: res.stderr ?? '' });
  };

  // promisify-aware custom impl so `promisify(execFile)` resolves to
  // `{ stdout, stderr }`. This mirrors what node ships for the real
  // execFile and what server/test/setup.ts preserves on the guard.
  (execFile as unknown as Record<symbol, unknown>)[customSym] = (
    _file: string,
    args: string[],
    opts?: ExecFileOptions,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      ghCalls.push({ args: [...args], opts });
      const res = ghHandler(args);
      if (res instanceof Error) reject(res);
      else resolve({ stdout: res.stdout, stderr: res.stderr ?? '' });
    });

  return {
    ...actual,
    execFile,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

// Avoid pulling in the real autofix templates from disk — the prompt body
// is asserted via header content, not template content.
vi.mock('../prompts/autofix/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadAutofixTemplate: (kind: string) => `TEMPLATE[${kind}]`,
  };
});

import { fanOutMergeConflictAutofix, type FanOutResult } from './webhooks.js';
import type { Project, KanbanCardRow, RouteDeps, ChatMessage } from '../types.js';

const SIBLING_PR_URL = 'https://github.com/owner/repo/pull/101';
const MERGED_PR = 99;
const BASE_REF = 'main';
const REPO = 'owner/repo';

function makeCard(prUrl: string, overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-sibling',
    column_id: 'col-in-progress',
    title: 'Sibling work',
    description: '',
    priority: 'medium',
    assignee: 'Author Agent',
    labels: null,
    session_id: 'sess-existing',
    github_issue_url: null,
    pr_url: prUrl,
    epic_id: null,
    dispatched_by_autonomous: 0,
    position: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as unknown as KanbanCardRow;
}

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    cwd: '/tmp',
    ahw: '',
    agents: [
      {
        id: 'author-1',
        name: 'Author Agent',
        role: 'author',
        engine: 'claude-code',
        model: 'claude-sonnet-4-20250514',
      },
    ],
  } as unknown as Project;
}

interface BuildDepsOpts {
  cardForPrUrl?: KanbanCardRow | undefined;
}

function buildDeps(opts: BuildDepsOpts = {}) {
  const existingSession = { agent_id: 'author-1' };
  const handleChat = vi.fn(
    async (
      _ws: unknown,
      msg: ChatMessage & { _onUserMessagePersisted?: (ok: boolean) => void },
    ) => {
      msg._onUserMessagePersisted?.(true);
    },
  );
  return {
    stmts: {
      getKanbanCardByPrUrl: { get: vi.fn(() => opts.cardForPrUrl) },
      getSession: { get: vi.fn(() => existingSession) },
    },
    broadcast: vi.fn(),
    findAgent: vi.fn(() => ({ project: makeProject(), agent: makeProject().agents[0] })),
    handleChat,
    config: { engineValidModels: {} },
  } as unknown as RouteDeps;
}

describe('fanOutMergeConflictAutofix — merge cascade', () => {
  beforeEach(() => {
    ghCalls.length = 0;
    ghHandler = () => ({ stdout: '' });
  });

  it('lists siblings on same base, fetches each, and dispatches conflict autofix when dirty', async () => {
    // Two siblings come back. #101 is CONFLICTING (cascade victim), #102 is
    // MERGEABLE/CLEAN (untouched). The just-merged PR #99 also appears in
    // the list — it must be skipped, not redispatched against itself.
    const list = [
      { number: MERGED_PR, url: 'https://github.com/owner/repo/pull/99' },
      { number: 101, url: SIBLING_PR_URL },
      { number: 102, url: 'https://github.com/owner/repo/pull/102' },
    ];
    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify(list) };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '101') {
        return {
          stdout: JSON.stringify({
            number: 101,
            title: 'Refactor parser',
            url: SIBLING_PR_URL,
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
            headRefName: 'feature/parser',
            baseRefName: 'main',
          }),
        };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '102') {
        return {
          stdout: JSON.stringify({
            number: 102,
            title: 'Unrelated tweak',
            url: 'https://github.com/owner/repo/pull/102',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            headRefName: 'feature/tweak',
            baseRefName: 'main',
          }),
        };
      }
      return { stdout: '' };
    };

    const siblingCard = makeCard(SIBLING_PR_URL);
    const deps = buildDeps({ cardForPrUrl: siblingCard });

    const result: FanOutResult = await fanOutMergeConflictAutofix(
      deps,
      makeProject(),
      REPO,
      BASE_REF,
      MERGED_PR,
    );

    // Sanity: we asked GitHub for siblings targeting the same base.
    const listCall = ghCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list');
    expect(listCall).toBeDefined();
    expect(listCall?.args).toEqual(
      expect.arrayContaining(['--repo', REPO, '--base', BASE_REF, '--state', 'open']),
    );

    // We probed each sibling with `gh pr view --json ...`, but never the
    // just-merged PR itself.
    const viewCalls = ghCalls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view');
    const probedNumbers = viewCalls.map((c) => c.args[2]).sort();
    expect(probedNumbers).toEqual(['101', '102']);

    // The view JSON projection asked for the fields we depend on.
    const fieldsArg = viewCalls[0]?.args[viewCalls[0].args.indexOf('--json') + 1] ?? '';
    expect(fieldsArg).toContain('mergeable');
    expect(fieldsArg).toContain('mergeStateStatus');

    // Result accounting.
    expect(result.checked).toBe(2);
    expect(result.dirty).toBe(1);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]).toMatchObject({ prNumber: 101, sessionId: 'sess-existing' });

    // Dispatch went through the existing session for #101's card with a
    // conflict-resolve prompt body. No new session is created — we route
    // through the linked session via dispatchReviewFeedback.
    const handleChat = deps.handleChat as unknown as ReturnType<typeof vi.fn>;
    expect(handleChat).toHaveBeenCalledTimes(1);
    const sentMsg = handleChat.mock.calls[0]?.[1] as ChatMessage;
    expect(sentMsg.sessionId).toBe('sess-existing');
    expect(sentMsg.content).toContain('## PR Context');
    expect(sentMsg.content).toContain('PR: #101 — Refactor parser');
    expect(sentMsg.content).toContain('TEMPLATE[conflict]');
    // We did NOT include review / ci templates — conflict-only on cascade.
    expect(sentMsg.content).not.toContain('TEMPLATE[review]');
    expect(sentMsg.content).not.toContain('TEMPLATE[ci]');
  });

  it('does not dispatch when no sibling has a linked kanban card', async () => {
    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ number: 101, url: SIBLING_PR_URL }]) };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 101,
            title: 'Refactor parser',
            url: SIBLING_PR_URL,
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
            headRefName: 'feature/parser',
            baseRefName: 'main',
          }),
        };
      }
      return { stdout: '' };
    };

    const deps = buildDeps({ cardForPrUrl: undefined });
    const result = await fanOutMergeConflictAutofix(deps, makeProject(), REPO, BASE_REF, MERGED_PR);

    expect(result.checked).toBe(1);
    expect(result.dirty).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect((deps.handleChat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('skips clean siblings (no dispatch, no conflict prompt)', async () => {
    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ number: 101, url: SIBLING_PR_URL }]) };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 101,
            title: 'All good',
            url: SIBLING_PR_URL,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            headRefName: 'feature/x',
            baseRefName: 'main',
          }),
        };
      }
      return { stdout: '' };
    };

    const deps = buildDeps({ cardForPrUrl: makeCard(SIBLING_PR_URL) });
    const result = await fanOutMergeConflictAutofix(deps, makeProject(), REPO, BASE_REF, MERGED_PR);

    expect(result.checked).toBe(1);
    expect(result.dirty).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect((deps.handleChat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('returns empty result without throwing when `gh pr list` fails', async () => {
    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return new Error('gh: not authenticated');
      }
      return { stdout: '' };
    };

    const deps = buildDeps({ cardForPrUrl: makeCard(SIBLING_PR_URL) });
    const result = await fanOutMergeConflictAutofix(deps, makeProject(), REPO, BASE_REF, MERGED_PR);

    expect(result).toEqual({ checked: 0, dirty: 0, dispatched: [] });
    // No view calls were attempted because the list step failed.
    expect(ghCalls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view')).toHaveLength(0);
  });
});
