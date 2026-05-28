/**
 * Tests for the Finalize PR-provenance marker (design §11).
 *
 * Two layers:
 *
 *   - **Unit** — exercise {@link hasPrBodyMarker}, {@link ensurePrBodyMarker},
 *     {@link writeFinalizeRunPrUrl}, and {@link classifyPr} / {@link isInternalPr}
 *     against mocked `Stmts`. Covers registry-hit, body-marker-fallback,
 *     neither (external), marker idempotency, fetcher failure handling.
 *
 *   - **Integration** — drive the helpers against a real in-memory
 *     `better-sqlite3` database with the actual `finalize_runs` schema.
 *     Simulates the orchestrator's push step (registry write + body
 *     stamp), then asserts that both lookup paths (registry first,
 *     body-marker fallback) classify the PR as internal.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import type { Stmts } from '../types.js';
import {
  PR_BODY_MARKER,
  classifyPr,
  ensurePrBodyMarker,
  hasPrBodyMarker,
  isInternalPr,
  writeFinalizeRunPrUrl,
} from './provenance.js';

// ─── Unit tests: body-marker helpers ───────────────────────────────────────

describe('hasPrBodyMarker', () => {
  it('returns true when the marker appears anywhere in the body', () => {
    expect(hasPrBodyMarker(`Some text\n\n${PR_BODY_MARKER}\n`)).toBe(true);
    expect(hasPrBodyMarker(`${PR_BODY_MARKER} prefix`)).toBe(true);
    expect(hasPrBodyMarker(PR_BODY_MARKER)).toBe(true);
  });

  it('returns false for empty / nullish bodies', () => {
    expect(hasPrBodyMarker('')).toBe(false);
    expect(hasPrBodyMarker(null)).toBe(false);
    expect(hasPrBodyMarker(undefined)).toBe(false);
  });

  it('returns false when only a different HTML comment is present', () => {
    expect(hasPrBodyMarker('<!-- some-other-marker -->')).toBe(false);
    expect(hasPrBodyMarker('<!-- hub-actions: not-finalized -->')).toBe(false);
  });
});

describe('ensurePrBodyMarker', () => {
  it('appends the marker with a blank-line separator to non-empty bodies', () => {
    const result = ensurePrBodyMarker('## Summary\n\nSomething happened.');
    expect(result).toBe(`## Summary\n\nSomething happened.\n\n${PR_BODY_MARKER}`);
    expect(hasPrBodyMarker(result)).toBe(true);
  });

  it('returns the marker on its own when the body is empty / nullish', () => {
    expect(ensurePrBodyMarker('')).toBe(PR_BODY_MARKER);
    expect(ensurePrBodyMarker(null)).toBe(PR_BODY_MARKER);
    expect(ensurePrBodyMarker(undefined)).toBe(PR_BODY_MARKER);
  });

  it('is idempotent — re-stamping an already-marked body is a no-op', () => {
    const stamped = ensurePrBodyMarker('Hello world');
    const stampedTwice = ensurePrBodyMarker(stamped);
    expect(stampedTwice).toBe(stamped);
    // Acceptance: the marker appears EXACTLY ONCE.
    const occurrences = stampedTwice.split(PR_BODY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('normalises trailing whitespace so the marker sits one blank line below the body', () => {
    expect(ensurePrBodyMarker('Body\n')).toBe(`Body\n\n${PR_BODY_MARKER}`);
    expect(ensurePrBodyMarker('Body\n\n\n')).toBe(`Body\n\n${PR_BODY_MARKER}`);
  });

  it('does not move an existing marker that is not at the end', () => {
    // A future PR description that put the marker mid-body still parses
    // as marked; we should not duplicate it. The exact placement is up
    // to the body's author.
    const body = `Intro\n${PR_BODY_MARKER}\nMore stuff after.`;
    expect(ensurePrBodyMarker(body)).toBe(body);
  });
});

// ─── Unit tests: writeFinalizeRunPrUrl ─────────────────────────────────────

describe('writeFinalizeRunPrUrl', () => {
  it('runs the prepared statement with (prUrl, runId) in that order', () => {
    const run = vi.fn();
    const stmts = { updateFinalizeRunPrUrl: { run } } as unknown as Pick<
      Stmts,
      'updateFinalizeRunPrUrl'
    >;

    writeFinalizeRunPrUrl({ stmts }, { runId: 'run-1', prUrl: 'https://github.com/o/r/pull/42' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('https://github.com/o/r/pull/42', 'run-1');
  });
});

// ─── Unit tests: classifyPr / isInternalPr ─────────────────────────────────

interface FakeRegistryDeps {
  stmts: { getFinalizeRunByPrUrl: { get: ReturnType<typeof vi.fn> } };
}

function fakeRegistry(hit: unknown | undefined): FakeRegistryDeps {
  return {
    stmts: { getFinalizeRunByPrUrl: { get: vi.fn().mockReturnValue(hit) } },
  };
}

describe('classifyPr — registry hit', () => {
  it('returns internal/registry without invoking the body fetcher', async () => {
    const fakeRow = {
      id: 'run-1',
      pr_url: 'https://github.com/o/r/pull/42',
    };
    const fetchPrBody = vi.fn(async () => 'should not be read');
    const result = await classifyPr(
      { ...fakeRegistry(fakeRow), fetchPrBody } as never,
      'https://github.com/o/r/pull/42',
    );

    expect(result.provenance).toBe('internal');
    expect(result.via).toBe('registry');
    expect(result.run).toEqual(fakeRow);
    expect(fetchPrBody).not.toHaveBeenCalled();
  });
});

describe('classifyPr — registry miss with body-marker fallback', () => {
  it('classifies internal/body_marker when the marker is in the fetched body', async () => {
    const fetchPrBody = vi.fn(async () => `## Summary\n${PR_BODY_MARKER}\n`);
    const result = await classifyPr(
      { ...fakeRegistry(undefined), fetchPrBody } as never,
      'https://github.com/o/r/pull/77',
    );

    expect(result.provenance).toBe('internal');
    expect(result.via).toBe('body_marker');
    expect(result.run).toBeNull();
    expect(fetchPrBody).toHaveBeenCalledWith('https://github.com/o/r/pull/77');
  });

  it('classifies external/none when the fetched body lacks the marker', async () => {
    const fetchPrBody = vi.fn(async () => 'Just a regular PR description.');
    const result = await classifyPr(
      { ...fakeRegistry(undefined), fetchPrBody } as never,
      'https://github.com/o/r/pull/99',
    );

    expect(result.provenance).toBe('external');
    expect(result.via).toBe('none');
    expect(result.run).toBeNull();
  });

  it('treats fetcher rejection as fallback-unavailable, classifies external', async () => {
    const fetchPrBody = vi.fn(async () => {
      throw new Error('GitHub API down');
    });
    const result = await classifyPr(
      { ...fakeRegistry(undefined), fetchPrBody } as never,
      'https://github.com/o/r/pull/1',
    );

    expect(result.provenance).toBe('external');
    expect(result.via).toBe('none');
  });

  it('classifies external when nothing is wired (no fetcher, no registry hit)', async () => {
    const result = await classifyPr(
      fakeRegistry(undefined) as never,
      'https://github.com/o/r/pull/1',
    );
    expect(result.provenance).toBe('external');
    expect(result.via).toBe('none');
  });
});

describe('classifyPr — empty / missing PR URL', () => {
  it('short-circuits to external without touching the registry', async () => {
    const getFn = vi.fn();
    const result = await classifyPr(
      { stmts: { getFinalizeRunByPrUrl: { get: getFn } } } as never,
      '',
    );
    expect(result.provenance).toBe('external');
    expect(result.via).toBe('none');
    expect(getFn).not.toHaveBeenCalled();
  });
});

describe('isInternalPr', () => {
  it('returns true on registry hit', async () => {
    expect(
      await isInternalPr(fakeRegistry({ id: 'run-1' }) as never, 'https://gh/o/r/pull/1'),
    ).toBe(true);
  });

  it('returns true on body-marker fallback', async () => {
    expect(
      await isInternalPr(
        {
          ...fakeRegistry(undefined),
          fetchPrBody: async () => `body with ${PR_BODY_MARKER}`,
        } as never,
        'https://gh/o/r/pull/1',
      ),
    ).toBe(true);
  });

  it('returns false when neither path matches', async () => {
    expect(
      await isInternalPr(
        { ...fakeRegistry(undefined), fetchPrBody: async () => 'plain body' } as never,
        'https://gh/o/r/pull/1',
      ),
    ).toBe(false);
  });
});

// ─── Integration: real sqlite finalize_runs round-trip ─────────────────────

/**
 * Spin up an in-memory sqlite with the actual finalize_runs schema so we
 * exercise the real UPDATE / SELECT statements end-to-end. This is the
 * integration test from the acceptance criteria — "push a PR through the
 * orchestrator → assert isInternalPr returns true via both lookup paths".
 *
 * The push-gate orchestrator (card 5c34b2de) is not implemented yet, so we
 * simulate its two side-effects (write pr_url + stamp marker into body)
 * directly. When the orchestrator lands, this test will continue to pass
 * because it's verifying the same contract.
 */
function buildIntegrationStmts(): {
  db: Database.Database;
  stmts: Pick<Stmts, 'updateFinalizeRunPrUrl' | 'getFinalizeRunByPrUrl'>;
  insertRun: (row: {
    id: string;
    card_id: string;
    project_id: string;
    branch: string;
    head_sha: string;
    idempotency_key: string;
    status: string;
    trigger_source: string;
    triggered_by_user_id: string;
    author_name: string;
    author_email: string;
  }) => void;
} {
  const db = new Database(':memory:');
  // Mirror the columns the production schema requires NOT NULL for.
  // Keep this in sync with `server/db.ts` if columns are added.
  db.exec(`
    CREATE TABLE finalize_runs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      session_id TEXT,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT,
      trigger_source TEXT NOT NULL,
      worktree_path TEXT,
      triggered_by_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      reviewer_verdict TEXT,
      failure_reason TEXT,
      failed_step_index INTEGER,
      failed_step_name TEXT,
      failed_step_exit_code INTEGER,
      retry_of_run_id TEXT,
      active_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pr_url TEXT
    );
  `);

  const updateFinalizeRunPrUrl = db.prepare('UPDATE finalize_runs SET pr_url = ? WHERE id = ?');
  const getFinalizeRunByPrUrl = db.prepare('SELECT * FROM finalize_runs WHERE pr_url = ? LIMIT 1');

  const insertStmt = db.prepare(
    `INSERT INTO finalize_runs
       (id, card_id, project_id, branch, head_sha, idempotency_key,
        status, trigger_source, triggered_by_user_id,
        author_name, author_email, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    db,
    stmts: {
      updateFinalizeRunPrUrl: updateFinalizeRunPrUrl as unknown as Stmts['updateFinalizeRunPrUrl'],
      getFinalizeRunByPrUrl: getFinalizeRunByPrUrl as unknown as Stmts['getFinalizeRunByPrUrl'],
    },
    insertRun: (row) => {
      insertStmt.run(
        row.id,
        row.card_id,
        row.project_id,
        row.branch,
        row.head_sha,
        row.idempotency_key,
        row.status,
        row.trigger_source,
        row.triggered_by_user_id,
        row.author_name,
        row.author_email,
        Date.now(),
      );
    },
  };
}

describe('integration — orchestrator push → isInternalPr', () => {
  const PR_URL = 'https://github.com/agent-hub/agent-hub/pull/4242';

  it('classifies as internal via the registry after the push step writes pr_url', async () => {
    const { stmts, insertRun } = buildIntegrationStmts();
    insertRun({
      id: 'run-int-1',
      card_id: 'card-1',
      project_id: 'proj-1',
      branch: 'feature/provenance',
      head_sha: 'aaaa1111',
      idempotency_key: 'idem-1',
      status: 'pushing',
      trigger_source: 'ui_button',
      triggered_by_user_id: 'user-1',
      author_name: 'Hub Lead Dev',
      author_email: 'lead@example.com',
    });

    // Simulate the push step: registry write + body stamp inside the
    // same transaction the push gate will eventually use.
    const stampedBody = ensurePrBodyMarker('## Summary\n\nProvenance marker shipped.');
    writeFinalizeRunPrUrl({ stmts }, { runId: 'run-int-1', prUrl: PR_URL });

    // Webhook side: registry hit short-circuits the body fetcher.
    const fetchPrBody = vi.fn(async () => stampedBody);
    const result = await classifyPr({ stmts, fetchPrBody }, PR_URL);

    expect(result.provenance).toBe('internal');
    expect(result.via).toBe('registry');
    expect((result.run as { id: string } | null)?.id).toBe('run-int-1');
    expect(fetchPrBody).not.toHaveBeenCalled();
  });

  it('falls back to the body marker when the registry row is gone (e.g. wiped / migrated)', async () => {
    const { stmts, insertRun, db } = buildIntegrationStmts();
    insertRun({
      id: 'run-int-2',
      card_id: 'card-2',
      project_id: 'proj-1',
      branch: 'feature/provenance-2',
      head_sha: 'bbbb2222',
      idempotency_key: 'idem-2',
      status: 'pushing',
      trigger_source: 'agent_block',
      triggered_by_user_id: 'user-1',
      author_name: 'Hub Lead Dev',
      author_email: 'lead@example.com',
    });

    const stampedBody = ensurePrBodyMarker('## Summary\n\nFallback path.');
    writeFinalizeRunPrUrl({ stmts }, { runId: 'run-int-2', prUrl: PR_URL });

    // Simulate the row being lost (DB swap / manual surgery / fresh
    // dev DB while the PR is still alive on GitHub).
    db.exec('DELETE FROM finalize_runs');

    const fetchPrBody = vi.fn(async () => stampedBody);
    const result = await classifyPr({ stmts, fetchPrBody }, PR_URL);

    expect(result.provenance).toBe('internal');
    expect(result.via).toBe('body_marker');
    expect(result.run).toBeNull();
    expect(fetchPrBody).toHaveBeenCalledTimes(1);
  });

  it('classifies as external when neither path matches (registry miss + no marker)', async () => {
    const { stmts } = buildIntegrationStmts();
    // No insert: registry is empty.
    const fetchPrBody = vi.fn(async () => '## Summary\n\nExternal contributor PR.');
    const result = await classifyPr({ stmts, fetchPrBody }, PR_URL);
    expect(result.provenance).toBe('external');
    expect(result.via).toBe('none');
  });

  it('survives the round-trip: ensurePrBodyMarker → hasPrBodyMarker → classifyPr fallback', async () => {
    const { stmts } = buildIntegrationStmts();
    const orchestratorBody = 'Feature description from the orchestrator.';
    const stampedBody = ensurePrBodyMarker(orchestratorBody);
    expect(hasPrBodyMarker(stampedBody)).toBe(true);

    const result = await isInternalPr({ stmts, fetchPrBody: async () => stampedBody }, PR_URL);
    expect(result).toBe(true);
  });
});
