/**
 * Regression test for the open-PR mergeability fan-out on the org dashboard.
 *
 * The dashboard renders up to OPEN_PR_LIMIT (30) open native PRs, and for each
 * hosted PR it computes `mergeable` by spawning two `revParse` calls plus a
 * `mergeTree`. The original implementation ran every row at once with
 * `Promise.all`, so a single dashboard load could launch ~90 concurrent git
 * processes (and concurrent users multiplied that immediately).
 *
 * The fix caps the row-level concurrency at `MERGEABILITY_CONCURRENCY`. This
 * test instruments the git-read layer to record the peak number of concurrent
 * git operations while a dashboard request processes many hosted PRs, and
 * asserts the peak stays within the bound implied by the cap. On the old
 * unbounded code the peak would equal the PR count, so this test would fail.
 *
 * It mocks `host.js` (force "hosted") and `git-read.js` (instrumented
 * revParse/mergeTree) at the top of its OWN module registry — vitest isolates
 * module registries per test file, so these mocks do not leak into the shared
 * harness used by the other dashboard tests.
 */
import { MERGEABILITY_CONCURRENCY } from '../routes/dashboard.js';

// Shared, hoisted concurrency probe accessible from both the mock factories
// (which run hoisted, before imports) and the test body.
const probe = vi.hoisted(() => {
  let inFlight = 0;
  let peak = 0;
  const enter = () => {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
  };
  const leave = () => {
    inFlight -= 1;
  };
  return {
    enter,
    leave,
    get peak() {
      return peak;
    },
    reset() {
      inFlight = 0;
      peak = 0;
    },
  };
});

vi.mock('../native-pr/host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native-pr/host.js')>();
  return {
    ...actual,
    isAgentHubHosted: () => true,
    hostedRepoExists: () => true,
    bareRepoPath: () => '/tmp/fake-bare-repo.git',
  };
});

vi.mock('../native-pr/git-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native-pr/git-read.js')>();
  // Each instrumented op yields to the event loop so overlapping rows are
  // actually observable as concurrent in-flight work.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    ...actual,
    revParse: async () => {
      probe.enter();
      try {
        await tick();
        return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      } finally {
        probe.leave();
      }
    },
    mergeTree: async () => {
      probe.enter();
      try {
        await tick();
        return { mergeable: true, treeOid: 'tree-oid', conflictDetail: null };
      } finally {
        probe.leave();
      }
    },
  };
});

const { getRequest, createProject } = await import('./helpers.js');

interface DashboardBody {
  openPRs: Array<{ prUrl: string; mergeable: boolean | null }>;
}

async function insertOpenNativePr(projectId: string, number: number): Promise<void> {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO pull_requests (
       id, project_id, number, title, body, head_branch, base_branch,
       head_sha, status, author, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', ?, 'main', 'deadbeef', 'open', 'finalize', ?, ?)`,
  ).run(
    `pr-${projectId}-${number}`,
    projectId,
    number,
    `Mergeability fan-out PR ${number}`,
    `feat-${number}`,
    now,
    now,
  );
}

describe('dashboard open-PR mergeability fan-out', () => {
  it('caps concurrent git operations regardless of how many hosted PRs are open', async () => {
    const request = await getRequest();
    const project = await createProject({ name: 'Mergeability fan-out concurrency project' });
    const projectId = project.id as string;

    // Seed well more PRs than the concurrency cap so an unbounded fan-out
    // would be clearly visible (and far above the bound).
    const prCount = 12;
    expect(prCount).toBeGreaterThan(MERGEABILITY_CONCURRENCY);
    for (let n = 0; n < prCount; n += 1) {
      await insertOpenNativePr(projectId, 9000 + n);
    }

    probe.reset();
    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    // Sanity: the mergeability path actually ran for our hosted PRs.
    const ours = body.openPRs.filter((p) => p.prUrl.startsWith(`/projects/${projectId}/pulls/`));
    expect(ours.length).toBeGreaterThanOrEqual(prCount);
    expect(ours.every((p) => p.mergeable === true)).toBe(true);

    // The probe must have observed real git work...
    expect(probe.peak).toBeGreaterThan(0);
    // ...but never more than the cap allows. Each row runs at most 2 parallel
    // revParse calls (the mergeTree runs after), so the worst case is
    // MERGEABILITY_CONCURRENCY * 2 concurrent ops. On the old unbounded code
    // the peak would reach ~2 * prCount, blowing past this bound.
    expect(probe.peak).toBeLessThanOrEqual(MERGEABILITY_CONCURRENCY * 2);
  });
});
