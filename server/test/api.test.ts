import type supertest from 'supertest';
import {
  getRequest,
  createProject,
  createAgent,
  createSession,
  createWikiPage,
  createCard,
  createThread,
} from './helpers.js';

let request: supertest.Agent;

// Per-test monotonic counter used alongside `Date.now()` for unique
// project IDs. Plain timestamps would collide if vitest is ever flipped
// to file-parallel execution (today the suite runs files sequentially,
// but flagging the seam here keeps these tests safe under any reporter).
let _uniqueCounter = 0;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

// ═══════════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await request.get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('projects');
    expect(res.body).toHaveProperty('agents');
  });

  it('returns version from package.json', async () => {
    const res = await request.get('/api/health').expect(200);
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Retired routes
// ═══════════════════════════════════════════════════════════════════

describe('Retired bug-request → kanban intake route', () => {
  it('POST /api/projects/:projectId/support-requests is gone (404)', async () => {
    // Regression: the legacy support-request intake (which dispatched an
    // intake agent to file a kanban card) has been retired. Only the customer
    // support module (`POST /api/bug-reports` → support ticket) remains. The
    // route must no longer be mounted.
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .post(`/api/projects/${projectId}/support-requests`)
      .field('type', 'bug')
      .field('title', 'should not route anywhere')
      .expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Projects CRUD
// ═══════════════════════════════════════════════════════════════════

describe('Projects', () => {
  describe('POST /api/projects', () => {
    it('creates a project with valid data', async () => {
      const res = await request
        .post('/api/projects')
        .send({ id: 'test-proj-1', name: 'Test Project', cwd: '/tmp', color: '#FF0000' })
        .expect(201);

      expect(res.body.id).toBe('test-proj-1');
      expect(res.body.name).toBe('Test Project');
      expect(res.body.color).toBe('#FF0000');
      expect(res.body.agents).toEqual([]);
    });

    it('rejects invalid project ID', async () => {
      await request.post('/api/projects').send({ id: 'invalid id!', name: 'Bad' }).expect(400);
    });

    it('rejects duplicate project ID', async () => {
      const proj = await createProject();
      await request.post('/api/projects').send({ id: proj.id, name: 'Duplicate' }).expect(409);
    });

    it('creates project with commands', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'proj-with-cmds',
          name: 'Cmds Project',
          cwd: '/tmp',
          commands: {
            install: 'npm install',
            build: 'npm run build',
            test: 'npm test',
            lint: 'npm run lint',
          },
        })
        .expect(201);

      expect(res.body.commands.install).toBe('npm install');
      expect(res.body.commands.test).toBe('npm test');
    });

    it('creates project with preCommitCommands', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'proj-precommit-create',
          name: 'Pre Project',
          cwd: '/tmp',
          preCommitCommands: ['npm run lint', '  '],
        })
        .expect(201);

      expect(res.body.preCommitCommands).toEqual(['npm run lint']);
    });

    it('creates project with checkHealCommands and checkHealMaxRounds', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'proj-check-heal-create',
          name: 'Heal Project',
          cwd: '/tmp',
          checkHealCommands: ['  npm run lint:fix  ', ''],
          checkHealMaxRounds: 4,
        })
        .expect(201);

      expect(res.body.checkHealCommands).toEqual(['npm run lint:fix']);
      expect(res.body.checkHealMaxRounds).toBe(4);
    });

    it('rejects POST when checkHealMaxRounds is present but out of range', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'proj-heal-rounds-bad-post',
          name: 'Bad rounds',
          cwd: '/tmp',
          checkHealMaxRounds: 0,
        })
        .expect(400);
      expect(String(res.body.error)).toMatch(/checkHealMaxRounds/i);
    });

    it('creates a tasks-only project (mode=workflow, no githubRepo)', async () => {
      // The "tasks-only" project shape: no GitHub repo, workflow mode so
      // session worktrees and PR automation stay off. Must be creatable in
      // a single POST with `mode: 'workflow'`.
      const res = await request
        .post('/api/projects')
        .send({
          id: 'tasks-only-proj',
          name: 'Tasks Only',
          cwd: '/tmp',
          mode: 'workflow',
        })
        .expect(201);
      expect(res.body.mode).toBe('workflow');
      expect(res.body.githubRepo).toBeUndefined();
    });

    it('points a workflow project cwd at a durable per-project resource dir (not /tmp)', async () => {
      // No-code projects have no worktree — every session runs in project.cwd.
      // The client's `/tmp` placeholder must be replaced server-side with a
      // durable, project-scoped dir under the managed data dir, created on disk.
      const { existsSync } = await import('fs');
      const path = await import('path');
      const projectId = `wf-cwd-${Date.now()}-${++_uniqueCounter}`;
      const res = await request
        .post('/api/projects')
        .send({ id: projectId, name: 'WF Cwd', cwd: '/tmp', mode: 'workflow' })
        .expect(201);
      const expected = path.join(res.body.ahw as string, 'workspace');
      expect(res.body.cwd).toBe(expected);
      expect(res.body.cwd).not.toBe('/tmp');
      expect(existsSync(res.body.cwd)).toBe(true);
    });

    it('leaves a dev project cwd as the caller-supplied path', async () => {
      // Only workflow mode gets the managed-dir override; dev projects keep
      // their explicit cwd (they run in a worktree derived from it anyway).
      const path = await import('path');
      const projectId = `dev-cwd-${Date.now()}-${++_uniqueCounter}`;
      const res = await request
        .post('/api/projects')
        .send({ id: projectId, name: 'Dev Cwd', cwd: '/tmp/dev-explicit' })
        .expect(201);
      expect(res.body.cwd).toBe('/tmp/dev-explicit');
      expect(res.body.cwd).not.toBe(path.join(res.body.ahw as string, 'workspace'));
    });

    it('scaffolds a workflow project with board, primary agent + docs (intake retired), and context files', async () => {
      // Workflow projects must land the user on a fully-formed shell — not
      // a blank canvas. The wizard's `POST /api/projects { mode: 'workflow' }`
      // call should eagerly initialise:
      //   - kanban board with the 4 default columns (To Do → Done)
      //   - the primary "<Project> Agent" (role: 'dev', id: '<id>-agent')
      //   - a Docs agent (role: 'docs') — seeded for every project
      //   - top-level context files (SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md)
      // Ticket Intake (role: 'intake') is RETIRED — never seeded anymore.
      // and explicitly NOT seed a Reviewer agent — Reviewer is GitHub-only
      // (`ensureReviewerAgents()` gates on `githubRepo` / webhook configs).
      const projectId = `wf-scaffold-${Date.now()}-${++_uniqueCounter}`;
      const res = await request
        .post('/api/projects')
        .send({ id: projectId, name: 'WF Scaffold', cwd: '/tmp', mode: 'workflow' })
        .expect(201);
      expect(res.body.mode).toBe('workflow');

      // Board + default columns are present immediately, not lazily on first GET.
      const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
      const columnNames = (board.body.columns as Array<{ name: string }>).map((c) => c.name);
      expect(columnNames).toEqual(['To Do', 'In Progress', 'Done']);

      // Project carries the primary "<Project> Agent" plus Docs.
      // Intake is retired (never seeded); Reviewer is deliberately absent
      // (no `githubRepo` on workflow projects).
      const proj = await request.get(`/api/projects/${projectId}`).expect(200);
      const agents =
        (proj.body.agents as Array<{
          id: string;
          name?: string;
          role?: string;
          engine?: string;
        }>) || [];
      const roles = agents.map((a) => a.role).filter(Boolean);
      expect(roles).toContain('dev');
      expect(roles).toContain('docs');
      expect(roles).not.toContain('intake');
      expect(roles).not.toContain('lead');
      expect(roles).not.toContain('reviewer');
      // Workflow projects: the primary agent is named "<Project> Agent" with
      // id `<projectId>-agent` (not `-dev`) — workflow workspaces have no
      // git repo, so the "Dev" label is reserved for coding projects.
      const primary = agents.find((a) => a.id === `${projectId}-agent`);
      expect(primary).toBeTruthy();
      expect(primary?.role).toBe('dev');
      expect(primary?.name).toBe('WF Scaffold Agent');
      // Default engine when no override is supplied = claude-code.
      expect(primary?.engine).toBe('claude-code');

      // Top-level context files (`ensureContextFiles`) are seeded immediately,
      // not deferred to the next server restart.
      const { existsSync } = await import('fs');
      const path = await import('path');
      const dataDir = (proj.body as { ahw: string }).ahw;
      for (const filename of ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md']) {
        expect(existsSync(path.join(dataDir, filename))).toBe(true);
      }
    });

    it('honours an optional `engine` override on the seeded workflow primary agent', async () => {
      // Cursor-only installs (or any non-Claude default) should be able to
      // pass `engine: 'cursor-agent'` on POST and have the seeded primary
      // agent come up with that engine — no follow-up PATCH required.
      const projectId = `wf-engine-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects')
        .send({
          id: projectId,
          name: 'WF Engine Override',
          cwd: '/tmp',
          mode: 'workflow',
          engine: 'cursor-agent',
        })
        .expect(201);
      const proj = await request.get(`/api/projects/${projectId}`).expect(200);
      const primary = (proj.body.agents as Array<{ id: string; engine?: string }>).find(
        (a) => a.id === `${projectId}-agent`,
      );
      expect(primary?.engine).toBe('cursor-agent');
    });

    it('honours `engine: codex-cli` on the seeded workflow primary agent', async () => {
      // Validates that 'codex-cli' (the canonical identifier used throughout
      // the server) is accepted — a typo in VALID_ENGINES ('codex') would
      // reject this with a 400 even though the caller is correct.
      const projectId = `wf-engine-codex-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects')
        .send({
          id: projectId,
          name: 'WF Codex Engine',
          cwd: '/tmp',
          mode: 'workflow',
          engine: 'codex-cli',
        })
        .expect(201);
      const proj = await request.get(`/api/projects/${projectId}`).expect(200);
      const primary = (proj.body.agents as Array<{ id: string; engine?: string }>).find(
        (a) => a.id === `${projectId}-agent`,
      );
      expect(primary?.engine).toBe('codex-cli');
    });

    it('rejects an invalid `engine` value with 400', async () => {
      await request
        .post('/api/projects')
        .send({
          id: `wf-bad-engine-${Date.now()}-${++_uniqueCounter}`,
          name: 'Bad Engine',
          cwd: '/tmp',
          mode: 'workflow',
          engine: 'not-a-real-engine',
        })
        .expect(400);
    });

    it('does NOT scaffold extra agents for dev-mode projects (lean POST)', async () => {
      // Regression guard: only `mode: 'workflow'` triggers the eager
      // scaffold. Dev-mode and unset-mode projects keep their lean POST
      // behavior — the richer `/api/projects/onboard` route owns dev
      // scaffolding because it has an analyzed agent roster to wire up.
      const devId = `dev-no-scaffold-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects')
        .send({ id: devId, name: 'Dev No Scaffold', cwd: '/tmp', mode: 'dev' })
        .expect(201);
      const proj = await request.get(`/api/projects/${devId}`).expect(200);
      expect((proj.body.agents as unknown[]).length).toBe(0);
    });

    it('rejects POST with an invalid mode value', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'bad-mode-proj',
          name: 'Bad Mode',
          cwd: '/tmp',
          mode: 'something-else',
        })
        .expect(400);
      expect(String(res.body.error)).toMatch(/mode/i);
    });

    it('omits mode when not provided (defaults to dev via getProjectMode)', async () => {
      const res = await request
        .post('/api/projects')
        .send({ id: 'no-mode-proj', name: 'No Mode', cwd: '/tmp' })
        .expect(201);
      expect(res.body.mode).toBeUndefined();
    });
  });

  describe('POST /api/projects/onboard', () => {
    it('persists the GitHub repo string onto the project so Settings shows it linked', async () => {
      // Regression: the import-from-GitHub wizard sends
      // `githubRepo: { owner, repo }` to /projects/onboard. Before the fix
      // the route used that pair to create a webhook config but never wrote
      // the derived `owner/repo` string back onto the project record, so the
      // Settings page (which reads `project.githubRepo` as a string)
      // rendered "No repo linked" for every imported repo.
      const projId = `onboard-gh-${Date.now()}-${++_uniqueCounter}`;
      const res = await request
        .post('/api/projects/onboard')
        .send({
          project: {
            id: projId,
            name: 'Onboard GH',
            cwd: '/tmp',
            githubRepo: { owner: 'acme', repo: 'widget' },
          },
          agents: [
            {
              id: `${projId}-dev`,
              name: 'Dev',
              engine: 'claude-code',
              systemPrompt: 'You are the dev agent.',
            },
          ],
        })
        .expect(201);
      expect(res.body.githubRepo).toBe('acme/widget');
      expect(res.body.repoUrl).toBe('https://github.com/acme/widget.git');

      // GET round-trip — confirms the link survived `saveProjects()` and
      // resurfaces on the read path the Settings page uses.
      const reload = await request.get(`/api/projects/${projId}`).expect(200);
      expect(reload.body.githubRepo).toBe('acme/widget');
      expect(reload.body.repoUrl).toBe('https://github.com/acme/widget.git');
    });

    it('does not set githubRepo when the GitHub block is omitted', async () => {
      const projId = `onboard-no-gh-${Date.now()}-${++_uniqueCounter}`;
      const res = await request
        .post('/api/projects/onboard')
        .send({
          project: { id: projId, name: 'Onboard No GH', cwd: '/tmp' },
          agents: [
            {
              id: `${projId}-dev`,
              name: 'Dev',
              engine: 'claude-code',
              systemPrompt: 'You are the dev agent.',
            },
          ],
        })
        .expect(201);
      expect(res.body.githubRepo).toBeUndefined();
      expect(res.body.repoUrl).toBeUndefined();
    });

    it('seeds reviewed wiki draft pages into the new project wiki', async () => {
      const projId = `onboard-wiki-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects/onboard')
        .send({
          project: { id: projId, name: 'Onboard Wiki', cwd: '/tmp' },
          agents: [
            {
              id: `${projId}-dev`,
              name: 'Dev',
              engine: 'claude-code',
              systemPrompt: 'You are the dev agent.',
            },
          ],
          wikiPages: [
            {
              title: ' Architecture Overview ',
              category: 'architecture',
              content: '# Architecture Overview\n\nUses a worker queue in `src/jobs.ts`.',
            },
            {
              title: 'Architecture Overview',
              category: 'general',
              content: 'Duplicate slug should be ignored.',
            },
            {
              title: 'Runbook',
              category: 'not-a-category',
              content: 'Start with `npm run dev`.',
            },
            {
              title: '   ',
              category: 'onboarding',
              content: 'Missing title should be ignored.',
            },
          ],
        })
        .expect(201);

      const pages = await request.get(`/api/projects/${projId}/wiki`).expect(200);
      expect(pages.body.map((page: { title: string }) => page.title).sort()).toEqual([
        'Architecture Overview',
        'Runbook',
      ]);

      const architecture = await request
        .get(`/api/projects/${projId}/wiki/architecture-overview`)
        .expect(200);
      expect(architecture.body).toMatchObject({
        title: 'Architecture Overview',
        category: 'architecture',
        updated_by: 'project-analysis',
      });
      expect(architecture.body.content).toContain('src/jobs.ts');

      const runbook = await request.get(`/api/projects/${projId}/wiki/runbook`).expect(200);
      expect(runbook.body.category).toBe('onboarding');

      const search = await request.get(`/api/projects/${projId}/wiki?q=worker`).expect(200);
      expect(
        search.body.some((page: { slug: string }) => page.slug === 'architecture-overview'),
      ).toBe(true);
    });

    it('rejects onboard when no valid dev agents remain after parsing', async () => {
      const projId = `onboard-empty-roster-${Date.now()}-${++_uniqueCounter}`;
      const emptyAgents = await request
        .post('/api/projects/onboard')
        .send({
          project: { id: projId, name: 'Empty Roster', cwd: '/tmp' },
          agents: [],
        })
        .expect(400);
      expect(emptyAgents.body.error).toBe('onboard_dev_roster_required');

      const projId2 = `onboard-no-agents-key-${Date.now()}-${++_uniqueCounter}`;
      const omitted = await request
        .post('/api/projects/onboard')
        .send({
          project: { id: projId2, name: 'No agents key', cwd: '/tmp' },
        })
        .expect(400);
      expect(omitted.body.error).toBe('onboard_dev_roster_required');

      await request.get(`/api/projects/${projId}`).expect(404);
      await request.get(`/api/projects/${projId2}`).expect(404);

      const projId3 = `onboard-invalid-agent-ids-${Date.now()}-${++_uniqueCounter}`;
      const invalidIds = await request
        .post('/api/projects/onboard')
        .send({
          project: { id: projId3, name: 'Invalid ids', cwd: '/tmp' },
          agents: [{ id: 'not valid!', name: 'x' }],
        })
        .expect(400);
      expect(invalidIds.body.error).toBe('onboard_dev_roster_required');
      await request.get(`/api/projects/${projId3}`).expect(404);
    });
  });

  describe('POST /api/projects/onboard — role-specialist seeding', () => {
    // The onboard route owns dev-mode scaffolding (analyzed roster + GitHub
    // wiring). It must seed Docs for every project and a Reviewer for projects
    // with a `githubRepo` set. Intake is retired (never seeded). Reviewer stays
    // out of non-GitHub onboards.
    it('seeds Docs (not Intake) on any onboarded project, and Reviewer when githubRepo is set', async () => {
      const projectId = `onboard-gh-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects/onboard')
        .send({
          project: {
            id: projectId,
            name: 'Onboard GH',
            cwd: '/tmp',
            githubRepo: { owner: 'octocat', repo: 'hello-world' },
          },
          agents: [
            {
              id: `${projectId}-dev`,
              name: 'Onboard GH Dev',
              role: 'dev',
              engine: 'claude-code',
              systemPrompt: 'You are the dev agent.',
            },
          ],
          contextFiles: {},
        })
        .expect(201);

      const proj = await request.get(`/api/projects/${projectId}`).expect(200);
      expect(proj.body.githubRepo).toBe('octocat/hello-world');
      const agents =
        (proj.body.agents as Array<{ id: string; role?: string; name?: string }>) || [];
      const roles = agents.map((a) => a.role).filter(Boolean);
      expect(roles).toContain('dev');
      expect(roles).toContain('docs');
      expect(roles).not.toContain('intake');
      expect(roles).toContain('reviewer');
      expect(agents.some((a) => a.id === `${projectId}-docs`)).toBe(true);
      expect(agents.some((a) => a.id === `${projectId}-intake`)).toBe(false);
      expect(agents.some((a) => a.id === `${projectId}-reviewer`)).toBe(true);
    });

    it('seeds Docs but NOT Intake or Reviewer when onboarded without a GitHub repo', async () => {
      const projectId = `onboard-nogh-${Date.now()}-${++_uniqueCounter}`;
      await request
        .post('/api/projects/onboard')
        .send({
          project: {
            id: projectId,
            name: 'Onboard NoGH',
            cwd: '/tmp',
          },
          agents: [
            {
              id: `${projectId}-dev`,
              name: 'Onboard NoGH Dev',
              role: 'dev',
              engine: 'claude-code',
              systemPrompt: 'You are the dev agent.',
            },
          ],
          contextFiles: {},
        })
        .expect(201);

      const proj = await request.get(`/api/projects/${projectId}`).expect(200);
      const agents = (proj.body.agents as Array<{ id: string; role?: string }>) || [];
      const roles = agents.map((a) => a.role).filter(Boolean);
      expect(roles).toContain('dev');
      expect(roles).toContain('docs');
      expect(roles).not.toContain('intake');
      expect(roles).not.toContain('reviewer');
      expect(agents.some((a) => a.id === `${projectId}-intake`)).toBe(false);
      expect(agents.some((a) => a.id === `${projectId}-reviewer`)).toBe(false);
    });
  });

  describe('GET /api/projects', () => {
    it('lists all projects', async () => {
      const res = await request.get('/api/projects').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/projects/:projectId', () => {
    it('returns a project by ID', async () => {
      const proj = await createProject();
      const res = await request.get(`/api/projects/${proj.id}`).expect(200);
      expect(res.body.id).toBe(proj.id);
    });

    it('returns 404 for missing project', async () => {
      await request.get('/api/projects/nonexistent-xyz').expect(404);
    });
  });

  describe('PATCH /api/projects/:projectId', () => {
    it('updates project name and color', async () => {
      const proj = await createProject();
      const res = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ name: 'Updated Name', color: '#00FF00' })
        .expect(200);

      expect(res.body.name).toBe('Updated Name');
      expect(res.body.color).toBe('#00FF00');
    });

    it('updates project mode and clears with null', async () => {
      const proj = await createProject();
      const wf = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ mode: 'workflow' })
        .expect(200);
      expect(wf.body.mode).toBe('workflow');

      const dev = await request.patch(`/api/projects/${proj.id}`).send({ mode: 'dev' }).expect(200);
      expect(dev.body.mode).toBe('dev');

      const cleared = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ mode: null })
        .expect(200);
      expect(cleared.body.mode).toBeUndefined();

      const bad = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ mode: 'staging' })
        .expect(400);
      expect(String(bad.body.error)).toMatch(/mode must/i);
    });

    it('persists project browser defaults and clears with null', async () => {
      const proj = await createProject();
      const setAll = await request
        .patch(`/api/projects/${proj.id}`)
        .send({
          browserToolsDefaultEnabled: false,
          browserViewportWidth: 1440,
          browserViewportHeight: 900,
          browserPageLoadTimeoutMs: 45_000,
        })
        .expect(200);
      expect(setAll.body.browserToolsDefaultEnabled).toBe(false);
      expect(setAll.body.browserViewportWidth).toBe(1440);
      expect(setAll.body.browserViewportHeight).toBe(900);
      expect(setAll.body.browserPageLoadTimeoutMs).toBe(45_000);

      const cleared = await request
        .patch(`/api/projects/${proj.id}`)
        .send({
          browserToolsDefaultEnabled: null,
          browserViewportWidth: null,
          browserViewportHeight: null,
          browserPageLoadTimeoutMs: null,
        })
        .expect(200);
      expect(cleared.body.browserToolsDefaultEnabled).toBeUndefined();
      expect(cleared.body.browserViewportWidth).toBeUndefined();
      expect(cleared.body.browserViewportHeight).toBeUndefined();
      expect(cleared.body.browserPageLoadTimeoutMs).toBeUndefined();
    });

    it('returns 400 for invalid project browser viewport', async () => {
      const proj = await createProject();
      await request
        .patch(`/api/projects/${proj.id}`)
        .send({ browserViewportWidth: 200 })
        .expect(400);
    });

    it('updates githubWorkflow settings', async () => {
      const proj = await createProject();
      const res = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ githubWorkflow: { autoMerge: true, waitForCI: true } })
        .expect(200);

      expect(res.body.githubWorkflow.autoMerge).toBe(true);
      expect(res.body.githubWorkflow.waitForCI).toBe(true);
    });

    it('updates githubWorkflow.reviewerModel and clears it when empty', async () => {
      const proj = await createProject();
      const withModel = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ githubWorkflow: { reviewerModel: '  claude-opus-4-20250514  ' } })
        .expect(200);
      expect(withModel.body.githubWorkflow.reviewerModel).toBe('claude-opus-4-20250514');

      const cleared = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ githubWorkflow: { reviewerModel: '' } })
        .expect(200);
      expect(cleared.body.githubWorkflow.reviewerModel).toBeUndefined();
    });

    it('returns 404 for nonexistent project', async () => {
      await request.patch('/api/projects/does-not-exist').send({ name: 'Nope' }).expect(404);
    });

    it('updates preCommitCommands and clears when empty array', async () => {
      const proj = await createProject();
      const withHooks = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ preCommitCommands: ['  npm run lint  ', 'npm test'] })
        .expect(200);
      expect(withHooks.body.preCommitCommands).toEqual(['npm run lint', 'npm test']);

      const cleared = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ preCommitCommands: [] })
        .expect(200);
      expect(cleared.body.preCommitCommands).toBeUndefined();
    });

    it('updates checkHealCommands / checkHealMaxRounds and clears heal list with empty array', async () => {
      const proj = await createProject();
      const withHeal = await request
        .patch(`/api/projects/${proj.id}`)
        .send({
          checkHealCommands: [' npm run format ', 'npm run lint:fix'],
          checkHealMaxRounds: 3,
        })
        .expect(200);
      expect(withHeal.body.checkHealCommands).toEqual(['npm run format', 'npm run lint:fix']);
      expect(withHeal.body.checkHealMaxRounds).toBe(3);

      const clearedHeal = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ checkHealCommands: [] })
        .expect(200);
      expect(clearedHeal.body.checkHealCommands).toBeUndefined();

      const clearedRounds = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ checkHealMaxRounds: null })
        .expect(200);
      expect(clearedRounds.body.checkHealMaxRounds).toBeUndefined();
    });

    it('rejects PATCH with invalid checkHealMaxRounds and leaves the stored value unchanged', async () => {
      const proj = await createProject();
      await request.patch(`/api/projects/${proj.id}`).send({ checkHealMaxRounds: 2 }).expect(200);

      const bad = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ checkHealMaxRounds: 99 })
        .expect(400);
      expect(String(bad.body.error)).toMatch(/checkHealMaxRounds/i);

      const roundTrip = await request.get(`/api/projects/${proj.id}`).expect(200);
      expect(roundTrip.body.checkHealMaxRounds).toBe(2);
    });

    it('updates orchestrationBudgets and clears with null', async () => {
      const proj = await createProject();
      const withOb = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ orchestrationBudgets: { maxContinuationDepth: 2, maxReactWallClockMs: 5000 } })
        .expect(200);
      expect(withOb.body.orchestrationBudgets).toEqual({
        maxContinuationDepth: 2,
        maxReactWallClockMs: 5000,
      });

      const cleared = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ orchestrationBudgets: null })
        .expect(200);
      expect(cleared.body.orchestrationBudgets).toBeUndefined();
    });

    it('sanitizes project orchestrationBudgets (strips unknown keys; empty payload deletes)', async () => {
      const proj = await createProject();
      await request
        .patch(`/api/projects/${proj.id}`)
        .send({ orchestrationBudgets: { maxContinuationDepth: 4 } })
        .expect(200);

      const unknownOnly = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ orchestrationBudgets: { notARealKey: 1 } })
        .expect(200);
      expect(unknownOnly.body.orchestrationBudgets).toBeUndefined();

      await request
        .patch(`/api/projects/${proj.id}`)
        .send({ orchestrationBudgets: { maxContinuationDepth: 3, junk: 'x' } })
        .expect(200);
      const r = await request.get(`/api/projects/${proj.id}`).expect(200);
      expect(r.body.orchestrationBudgets).toEqual({ maxContinuationDepth: 3 });
    });
  });

  describe('DELETE /api/projects/:projectId', () => {
    it('deletes a project', async () => {
      const proj = await createProject();
      await request.delete(`/api/projects/${proj.id}`).expect(204);
      await request.get(`/api/projects/${proj.id}`).expect(404);
    });

    it('returns 404 for nonexistent project', async () => {
      await request.delete('/api/projects/does-not-exist').expect(404);
    });

    it('cleans up associated wiki, board, and thread data', async () => {
      const proj = await createProject();

      await createWikiPage(proj.id as string, { title: 'Cleanup Test' });
      await createCard(proj.id as string, { title: 'Cleanup Card' });
      await createThread(proj.id as string, { name: 'Cleanup Thread' });

      await request.get(`/api/projects/${proj.id}/wiki`).expect(200);
      const boardRes = await request.get(`/api/projects/${proj.id}/board`).expect(200);
      expect(boardRes.body.cards.length).toBeGreaterThan(0);

      await request.delete(`/api/projects/${proj.id}`).expect(204);

      await request.get(`/api/projects/${proj.id}/wiki`).expect(404);
      await request.get(`/api/projects/${proj.id}/board`).expect(404);
      await request.get(`/api/projects/${proj.id}/threads`).expect(404);
    });

    it('removes the canonical project skill store', async () => {
      const { existsSync, mkdirSync, rmSync, writeFileSync } = await import('fs');
      const path = await import('path');
      const { resolveProjectSkillsDir } = await import('../project-model.js');
      const proj = await createProject();
      const skillsDir = resolveProjectSkillsDir(proj as { id: string; ahw?: string });

      rmSync(skillsDir, { recursive: true, force: true });
      mkdirSync(path.join(skillsDir, 'custom-skill'), { recursive: true });
      writeFileSync(path.join(skillsDir, 'custom-skill', 'SKILL.md'), '---\nname: Custom\n---\n');

      await request.delete(`/api/projects/${proj.id}`).expect(204);

      expect(existsSync(skillsDir)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Agents CRUD
// ═══════════════════════════════════════════════════════════════════

describe('Agents', () => {
  describe('POST /api/agents', () => {
    it('creates an agent under a project', async () => {
      const proj = await createProject();
      const res = await request
        .post('/api/agents')
        .send({ id: 'test-agent-1', projectId: proj.id, name: 'Test Agent', engine: 'claude-code' })
        .expect(201);

      expect(res.body.id).toBe('test-agent-1');
      expect(res.body.name).toBe('Test Agent');
      expect(res.body.engine).toBe('claude-code');
    });

    it('rejects agent without projectId', async () => {
      await request
        .post('/api/agents')
        .send({ id: 'orphan-agent', name: 'No Project' })
        .expect(400);
    });

    it('rejects invalid agent ID', async () => {
      const proj = await createProject();
      await request.post('/api/agents').send({ id: 'bad id!', projectId: proj.id }).expect(400);
    });

    it('rejects duplicate agent ID', async () => {
      const agent = await createAgent();
      const proj = await createProject();
      await request.post('/api/agents').send({ id: agent.id, projectId: proj.id }).expect(409);
    });

    it('persists browserToolsEnabled=false on create', async () => {
      const proj = await createProject();
      const res = await request
        .post('/api/agents')
        .send({
          id: 'bt-off-agent',
          projectId: proj.id,
          name: 'Browser off',
          engine: 'claude-code',
          browserToolsEnabled: false,
        })
        .expect(201);

      expect(res.body.browserToolsEnabled).toBe(false);
    });

    it('rejects non-boolean browserToolsEnabled on create', async () => {
      const proj = await createProject();
      const res = await request
        .post('/api/agents')
        .send({
          id: 'bt-bad-create',
          projectId: proj.id,
          name: 'Bad bool',
          engine: 'claude-code',
          browserToolsEnabled: 'false',
        })
        .expect(400);

      expect(res.body.error).toMatch(/browserToolsEnabled must be a boolean/i);
    });
  });

  describe('GET /api/agents', () => {
    it('lists all agents with enriched data', async () => {
      await createAgent();
      const res = await request.get('/api/agents').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0]).toHaveProperty('lastActivity');
    });
  });

  describe('POST /api/agents/bulk-engine', () => {
    it('returns 401 when unauthenticated', async () => {
      await request.post('/api/agents/bulk-engine').send({ engine: 'claude-code' }).expect(401);
    });

    // The endpoint writes per-user overrides, so it auth-gates before it
    // validates the body — an unauthenticated caller gets 401 even with an
    // invalid engine. (The 400 validation path is covered with an
    // authenticated caller in routes/agents-bulk-engine-per-user.test.ts;
    // this no-auth integration harness never carries an authUserId.)
    it('auth-gates before body validation (401, not 400)', async () => {
      await request
        .post('/api/agents/bulk-engine')
        .send({ engine: 'not-an-engine', model: 'x' })
        .expect(401);
    });
  });

  describe('PATCH /api/agents/:agentId', () => {
    it('updates agent name and engine', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ name: 'Renamed Agent', engine: 'cursor-agent' })
        .expect(200);

      expect(res.body.name).toBe('Renamed Agent');
      expect(res.body.engine).toBe('cursor-agent');
    });

    it('returns 404 for nonexistent agent', async () => {
      await request.patch('/api/agents/nope').send({ name: 'X' }).expect(404);
    });

    it('rejects model in PATCH body with 400 (model is per-user)', async () => {
      const agent = await createAgent({ model: 'claude-sonnet-4-6' });
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ model: 'gpt-5.5' })
        .expect(400);
      expect(res.body.error).toMatch(/model is per-user/i);
      // The shared row must be untouched by the rejected write.
      const after = await request.get('/api/agents').expect(200);
      const row = after.body.find((a: { id: string }) => a.id === agent.id);
      expect(row.model).toBe('claude-sonnet-4-6');
    });

    it('still applies other fields when model is absent', async () => {
      const agent = await createAgent({ model: 'claude-sonnet-4-6' });
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ name: 'Renamed Agent' })
        .expect(200);
      expect(res.body.name).toBe('Renamed Agent');
    });

    it('persists an icon-style avatar', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ avatar: 'icon:Crown' })
        .expect(200);

      expect(res.body.avatar).toBe('icon:Crown');

      // Round-trip: the value must still be there on a fresh GET.
      const list = await request.get('/api/agents').expect(200);
      const fetched = list.body.find((a: { id: string }) => a.id === agent.id);
      expect(fetched?.avatar).toBe('icon:Crown');
    });

    it('persists an uploaded-image avatar path', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ avatar: '/uploads/abc123.png' })
        .expect(200);

      expect(res.body.avatar).toBe('/uploads/abc123.png');
    });

    it('persists browserToolsEnabled=false and round-trips it', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ browserToolsEnabled: false })
        .expect(200);

      expect(res.body.browserToolsEnabled).toBe(false);

      const list = await request.get('/api/agents').expect(200);
      const fetched = list.body.find((a: { id: string }) => a.id === agent.id);
      expect(fetched?.browserToolsEnabled).toBe(false);
    });

    it('rejects non-boolean browserToolsEnabled on patch', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ browserToolsEnabled: 'false' })
        .expect(400);

      expect(res.body.error).toMatch(/browserToolsEnabled must be a boolean/i);
    });

    it('persists browser viewport and timeout overrides and clears with null', async () => {
      const agent = await createAgent();
      const setNums = await request
        .patch(`/api/agents/${agent.id}`)
        .send({
          browserViewportWidth: 1024,
          browserViewportHeight: 768,
          browserPageLoadTimeoutMs: 45_000,
        })
        .expect(200);
      expect(setNums.body.browserViewportWidth).toBe(1024);
      expect(setNums.body.browserViewportHeight).toBe(768);
      expect(setNums.body.browserPageLoadTimeoutMs).toBe(45_000);

      const cleared = await request
        .patch(`/api/agents/${agent.id}`)
        .send({
          browserViewportWidth: null,
          browserViewportHeight: null,
          browserPageLoadTimeoutMs: null,
        })
        .expect(200);
      expect(cleared.body.browserViewportWidth).toBeUndefined();
      expect(cleared.body.browserViewportHeight).toBeUndefined();
      expect(cleared.body.browserPageLoadTimeoutMs).toBeUndefined();

      await request
        .patch(`/api/agents/${agent.id}`)
        .send({ browserViewportWidth: 200 })
        .expect(400);
    });
  });

  describe('DELETE /api/agents/:agentId', () => {
    it('deletes an agent', async () => {
      const agent = await createAgent();
      await request.delete(`/api/agents/${agent.id}`).expect(204);
    });

    it('returns 404 for nonexistent agent', async () => {
      await request.delete('/api/agents/nope').expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sessions
// ═══════════════════════════════════════════════════════════════════

describe('Sessions', () => {
  describe('POST /api/agents/:agentId/sessions', () => {
    it('creates a session for an agent', async () => {
      const agent = await createAgent();
      const res = await request
        .post(`/api/agents/${agent.id}/sessions`)
        .send({ name: 'My Session' });

      expect(res.body).toHaveProperty('id');
      expect(res.body.agent_id).toBe(agent.id);
      expect(res.body.name).toBe('My Session');
    });

    it('forces use_worktree=1 on user-facing session creation, even in workflow mode', async () => {
      // Agent Hub is now worktree-only for all user-facing session
      // creation, regardless of project mode. The `use_worktree` column
      // survives on the row for legacy data + internal callers (e.g.,
      // preview-wizard) but cannot be toggled off via this route.
      const proj = await createProject();
      await request.patch(`/api/projects/${proj.id}`).send({ mode: 'workflow' }).expect(200);
      const agent = await createAgent({ projectId: String(proj.id) });
      const res = await request
        .post(`/api/agents/${agent.id}/sessions`)
        .send({ name: 'Workflow session' })
        .expect(200);
      expect(res.body.use_worktree).toBe(1);
    });

    it('returns 404 for the legacy PUT /sessions/:id/worktree endpoint', async () => {
      // The user-facing worktree toggle was removed when Agent Hub
      // locked to worktree-only sessions. Express returns 404 because
      // no handler is mounted at this path anymore.
      const agent = await createAgent();
      const session = await createSession({ agentId: agent.id as string, name: 'S' });
      await request.put(`/api/sessions/${session.id}/worktree`).send({ enabled: true }).expect(404);
    });
  });

  describe('GET /api/agents/:agentId/sessions', () => {
    it('lists sessions for an agent', async () => {
      const agent = await createAgent();
      await createSession({ agentId: agent.id as string, name: 'S1' });
      await createSession({ agentId: agent.id as string, name: 'S2' });

      const res = await request.get(`/api/agents/${agent.id}/sessions`).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/sessions/:sessionId/messages', () => {
    it('returns empty messages for new session', async () => {
      const session = await createSession();
      const res = await request.get(`/api/sessions/${session.id}/messages`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    it('honors ?limit= to return only the newest messages', async () => {
      const session = await createSession();
      const sessionId = session.id as string;
      const { getDb } = await import('../db.js');
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      );
      insert.run('m1', sessionId, 'first', '2026-01-01T00:00:00.000Z');
      insert.run('m2', sessionId, 'second', '2026-01-01T00:01:00.000Z');
      insert.run('m3', sessionId, 'third', '2026-01-01T00:02:00.000Z');

      const res = await request.get(`/api/sessions/${sessionId}/messages?limit=2`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((m: { content: string }) => m.content)).toEqual(['second', 'third']);
    });

    it('keyset-paginates with ?paginated=1 and walks older pages via ?before=', async () => {
      const session = await createSession();
      const sessionId = session.id as string;
      const { getDb } = await import('../db.js');
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      );
      // Five messages all sharing the same created_at second — the keyset cursor
      // must stay stable despite the collision (rowid, not created_at).
      const ts = '2026-02-02T00:00:00.000Z';
      for (let i = 1; i <= 5; i++) insert.run(`p${i}`, sessionId, `body ${i}`, ts);

      // Newest page (page size 2): plain oldest-first array of the newest 2.
      const page1 = await request
        .get(`/api/sessions/${sessionId}/messages?paginated=1&limit=2`)
        .expect(200);
      expect(Array.isArray(page1.body)).toBe(true);
      expect(page1.body.map((m: { id: string }) => m.id)).toEqual(['p4', 'p5']);

      // Next older page keyed off the oldest loaded id (p4).
      const page2 = await request
        .get(`/api/sessions/${sessionId}/messages?paginated=1&limit=2&before=p4`)
        .expect(200);
      expect(page2.body.map((m: { id: string }) => m.id)).toEqual(['p2', 'p3']);

      // Final page: one row older than p2.
      const page3 = await request
        .get(`/api/sessions/${sessionId}/messages?paginated=1&limit=2&before=p2`)
        .expect(200);
      expect(page3.body.map((m: { id: string }) => m.id)).toEqual(['p1']);

      // Past the start: no rows older than the oldest message.
      const page4 = await request
        .get(`/api/sessions/${sessionId}/messages?paginated=1&limit=2&before=p1`)
        .expect(200);
      expect(page4.body).toEqual([]);
    });

    it('returns an empty array for a paginated request on an empty session', async () => {
      const session = await createSession();
      const res = await request.get(`/api/sessions/${session.id}/messages?paginated=1`).expect(200);
      expect(res.body).toEqual([]);
    });

    // Guards the Phase-2 async-DB migration: the non-paginated branch now loads
    // the full transcript through the async reader facade (readAll). Response
    // must stay byte-for-byte identical to the old sync path: every message,
    // oldest-first by created_at then rowid.
    it('returns the full transcript oldest-first via the async reader path', async () => {
      const session = await createSession();
      const sessionId = session.id as string;
      const { getDb } = await import('../db.js');
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('t1', sessionId, 'user', 'one', '2026-03-01T00:00:00.000Z');
      insert.run('t2', sessionId, 'assistant', 'two', '2026-03-01T00:01:00.000Z');
      insert.run('t3', sessionId, 'user', 'three', '2026-03-01T00:02:00.000Z');

      const res = await request.get(`/api/sessions/${sessionId}/messages`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((m: { id: string }) => m.id)).toEqual(['t1', 't2', 't3']);
      expect(res.body.map((m: { content: string }) => m.content)).toEqual(['one', 'two', 'three']);
    });

    it('treats a before cursor from another session as an empty page (no cross-session leak)', async () => {
      const sessionA = await createSession();
      const sessionB = await createSession();
      const { getDb } = await import('../db.js');
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      );
      // Session A's messages get the LOWER rowids (inserted first), so a global
      // (un-scoped) `rowid < B's id` threshold would wrongly return A's rows.
      insert.run('a1', sessionA.id, 'a-one', '2026-03-03T00:00:00.000Z');
      insert.run('a2', sessionA.id, 'a-two', '2026-03-03T00:00:00.000Z');
      insert.run('b1', sessionB.id, 'b-one', '2026-03-03T00:00:01.000Z');

      // Use session B's message id as the cursor while querying session A.
      const res = await request
        .get(`/api/sessions/${sessionA.id}/messages?paginated=1&limit=10&before=b1`)
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/sessions/:sessionId/summary', () => {
    it('returns session, project, run snapshot, and skills', async () => {
      const session = await createSession();
      const res = await request.get(`/api/sessions/${session.id}/summary`).expect(200);
      expect(res.body.session.id).toBe(session.id);
      expect(res.body).toHaveProperty('projectId');
      expect(res.body).toHaveProperty('projectGithubRepo');
      expect(res.body).toHaveProperty('linkedCard');
      expect(res.body).toHaveProperty('finalizePrUrl');
      expect(res.body.finalizePrUrl).toBeNull();
      expect(res.body).toHaveProperty('sessionTitlePrUrl');
      expect(res.body.sessionTitlePrUrl).toBeNull();
      expect(res.body).toHaveProperty('runSnapshot');
      expect(res.body.runSnapshot).toMatchObject({ toolCalls: 0, files: [] });
      expect(res.body.runSnapshot.aggregationSkipped).toBeFalsy();
      expect(res.body).toHaveProperty('skills');
      expect(Array.isArray(res.body.skills)).toBe(true);
    });

    it('returns 404 for a non-existent session', async () => {
      await request.get('/api/sessions/00000000-0000-0000-0000-000000000001/summary').expect(404);
    });

    it('exposes sessionTitlePrUrl from Resolve/Review-style session name when card has no pr_url', async () => {
      const project = await createProject();
      await request
        .patch(`/api/projects/${project.id as string}`)
        .send({ githubRepo: 'acme/widgets' })
        .expect(200);
      const agent = await createAgent({ projectId: project.id as string });
      const session = await createSession({
        agentId: agent.id as string,
        name: '[Resolve PR #77] Fix flaky test',
      });
      const res = await request.get(`/api/sessions/${session.id as string}/summary`).expect(200);
      expect(res.body.sessionTitlePrUrl).toBe('https://github.com/acme/widgets/pull/77');
      expect(res.body.projectGithubRepo).toBe('acme/widgets');
      expect(res.body.linkedCard).toBeNull();
    });

    it('exposes finalizePrUrl from the latest pushed finalize run when card has no pr_url', async () => {
      const project = await createProject();
      await request
        .patch(`/api/projects/${project.id as string}`)
        .send({ githubRepo: 'acme/widgets' })
        .expect(200);
      const agent = await createAgent({ projectId: project.id as string });
      const session = await createSession({
        agentId: agent.id as string,
        name: '[Resolve PR #77] Title fallback should lose to finalize',
      });
      const { randomUUID } = await import('node:crypto');
      const { stmts } = await import('../db.js');
      if (!stmts) throw new Error('Database not initialized');

      const runId = randomUUID();
      stmts.insertFinalizeRun.run(
        runId,
        'card-finalize-summary',
        session.id,
        project.id,
        'feature/finalize-summary',
        'abc123',
        `summary-${runId}`,
        'pushed',
        'push',
        'ui_button',
        '/tmp/finalize-summary',
        'owner-user',
        'Agent Hub',
        'agent@example.test',
        null,
        Date.now(),
        'full',
      );
      stmts.updateFinalizeRunPrUrl.run('https://github.com/acme/widgets/pull/1240', runId);

      const res = await request.get(`/api/sessions/${session.id as string}/summary`).expect(200);
      expect(res.body.finalizePrUrl).toBe('https://github.com/acme/widgets/pull/1240');
      expect(res.body.sessionTitlePrUrl).toBeNull();
      expect(res.body.linkedCard).toBeNull();
    });

    it('does not set sessionTitlePrUrl when the linked card already has pr_url', async () => {
      const project = await createProject();
      await request
        .patch(`/api/projects/${project.id as string}`)
        .send({ githubRepo: 'acme/widgets' })
        .expect(200);
      const agent = await createAgent({ projectId: project.id as string });
      const session = await createSession({
        agentId: agent.id as string,
        name: 'Review: PR #99 Should be ignored when card wins',
      });
      const sessionId = session.id as string;
      const boardRes = await request.get(`/api/projects/${project.id as string}/board`).expect(200);
      const colId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;
      const cardRes = await request
        .post(`/api/projects/${project.id as string}/board/cards`)
        .send({
          columnId: colId,
          title: `Linked ${Date.now()}`,
          description: '',
          session_id: sessionId,
        })
        .expect(200);
      const cardId = (cardRes.body as { id: string }).id;
      await request
        .put(`/api/projects/${project.id as string}/board/cards/${cardId}`)
        .send({ prUrl: 'https://github.com/other/repo/pull/1' })
        .expect(200);
      const res = await request.get(`/api/sessions/${sessionId}/summary`).expect(200);
      expect(res.body.linkedCard?.pr_url).toBe('https://github.com/other/repo/pull/1');
      expect(res.body.sessionTitlePrUrl).toBeNull();
      expect(res.body.projectGithubRepo).toBe('acme/widgets');
      expect(cardId).toBe(res.body.linkedCard?.id);
    });

    it('returns aggregation-skipped run snapshot when session event count exceeds cap', async () => {
      const { setSnapshotAggregateLimitForTests } = await import('../session-run-snapshot.js');
      const testCap = 12;
      setSnapshotAggregateLimitForTests(testCap);
      try {
        const session = await createSession();
        const sessionId = session.id as string;
        const { randomUUID } = await import('node:crypto');
        const messageId = randomUUID();
        const { stmts, db } = await import('../db.js');
        if (!stmts || !db) throw new Error('Database not initialized');

        stmts.addMessage.run(
          messageId,
          sessionId,
          'assistant',
          '{}',
          'claude-code',
          null,
          null,
          null,
          null,
          null,
          null,
        );

        const insertOverCap = db.transaction(() => {
          for (let seq = 0; seq <= testCap; seq++) {
            stmts.addSessionEvent.run('message', messageId, seq, 'text', '{}');
          }
        });
        insertOverCap();

        const res = await request.get(`/api/sessions/${sessionId}/summary`).expect(200);
        expect(res.body.runSnapshot.aggregationSkipped).toBe(true);
        expect(res.body.runSnapshot.sessionEventCount).toBe(testCap + 1);
        expect(res.body.runSnapshot.files).toEqual([]);
        expect(res.body.runSnapshot.toolCalls).toBe(0);
      } finally {
        setSnapshotAggregateLimitForTests(null);
      }
    });
  });

  describe('PATCH /api/sessions/:sessionId', () => {
    it('renames a session', async () => {
      const session = await createSession();
      const res = await request
        .patch(`/api/sessions/${session.id}`)
        .send({ name: 'Renamed Session' })
        .expect(200);

      expect(res.body.name).toBe('Renamed Session');
    });
  });

  describe('PUT /api/sessions/:sessionId/task-state (removed)', () => {
    it('returns 404 for all bodies — REST task-state was removed with the task-plan revert', async () => {
      const session = await createSession();
      await request
        .put(`/api/sessions/${session.id}/task-state`)
        .send({
          taskState: {
            goal: 'Finish API',
            checklist: [{ text: 'Add tests', done: false }],
            lastFailure: 'CI red',
          },
        })
        .expect(404);
      await request
        .put(`/api/sessions/${session.id}/task-state`)
        .send({ taskState: { goal: 'x' } })
        .expect(404);
      await request
        .put(`/api/sessions/${session.id}/task-state`)
        .send({ taskState: null })
        .expect(404);
      await request.put(`/api/sessions/${session.id}/task-state`).send({}).expect(404);
    });
  });

  describe('PUT /api/sessions/:sessionId/engine', () => {
    it('switches session engine', async () => {
      const session = await createSession();
      const res = await request
        .put(`/api/sessions/${session.id}/engine`)
        .send({ engine: 'cursor-agent' })
        .expect(200);

      expect(res.body.engine).toBe('cursor-agent');
    });

    it('rejects invalid engine', async () => {
      const session = await createSession();
      await request
        .put(`/api/sessions/${session.id}/engine`)
        .send({ engine: 'invalid-engine' })
        .expect(400);
    });
  });

  describe('DELETE /api/sessions/:sessionId', () => {
    it('deletes a session', async () => {
      const session = await createSession();
      await request.delete(`/api/sessions/${session.id}`).expect(200);
      const res = await request.get(`/api/sessions/${session.id}/messages`).expect(200);
      expect(res.body).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Kanban Board
// ═══════════════════════════════════════════════════════════════════

describe('Kanban Board', () => {
  let testProject: Record<string, unknown>;

  beforeAll(async () => {
    testProject = await createProject();
  });

  describe('GET /api/projects/:projectId/board', () => {
    it('returns board with default columns', async () => {
      const res = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      expect(res.body).toHaveProperty('columns');
      expect(Array.isArray(res.body.columns)).toBe(true);
      expect(res.body.columns.length).toBe(3);
      const names = (res.body.columns as Array<{ name: string }>).map((c) => c.name);
      expect(names).toContain('To Do');
      expect(names).toContain('Done');
      expect(names).not.toContain('Review');
      expect(names).not.toContain('Backlog');
    });

    // Board enrichment: each card carries `finalize_run` (the latest
    // `finalize_runs` row for its session_id, or `null`). The client
    // <FinalizeCardBadge /> reads this as `prefetchedRun` and skips its
    // own GET — eliminates the N+1 fan-out the v0 surface had. PR #1169.
    it('attaches finalize_run to each card (one row per session, null otherwise)', async () => {
      const proj = await createProject();
      const agent = await createAgent({ projectId: proj.id as string });

      // Card A — session has a finalize_runs row → attached.
      const sessionWithRun = await createSession({ agentId: agent.id as string });
      const cardA = await createCard(proj.id as string, {
        title: 'Card with finalize run',
        sessionId: sessionWithRun.id as string,
      });

      // Card B — session has NO finalize_runs row → attached as null.
      const sessionNoRun = await createSession({ agentId: agent.id as string });
      const cardB = await createCard(proj.id as string, {
        title: 'Card with session, no run',
        sessionId: sessionNoRun.id as string,
      });

      // Card C — no session at all → attached as null.
      const cardC = await createCard(proj.id as string, { title: 'Card with no session' });

      const { stmts, db } = await import('../db.js');
      if (!stmts || !db) throw new Error('Database not initialized');

      // Insert two finalize_runs for the same session — only the newer
      // one (by started_at) should be attached. Verifies the window-
      // function picker agrees with the single-row endpoint.
      const insert = db.prepare(
        `INSERT INTO finalize_runs
           (id, card_id, session_id, project_id, branch, head_sha,
            idempotency_key, status, trigger_source, triggered_by_user_id,
            author_name, author_email, active_seconds_consumed, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'run-old-' + cardA.id,
        cardA.id,
        sessionWithRun.id,
        proj.id,
        'main',
        'aaaa1111',
        'idem-old-' + cardA.id,
        'failed',
        'ui_button',
        'user-1',
        'Dev',
        'dev@example.com',
        300,
        Date.now() - 100_000,
      );
      insert.run(
        'run-new-' + cardA.id,
        cardA.id,
        sessionWithRun.id,
        proj.id,
        'main',
        'bbbb2222',
        'idem-new-' + cardA.id,
        'reviewing',
        'ui_button',
        'user-1',
        'Dev',
        'dev@example.com',
        120,
        Date.now(),
      );

      const res = await request.get(`/api/projects/${proj.id as string}/board`).expect(200);
      const cards = res.body.cards as Array<{
        id: string;
        session_id: string | null;
        finalize_run: { id: string; status: string; session_id: string } | null;
      }>;
      const byId = new Map(cards.map((c) => [c.id, c] as const));

      // Card A — latest run wins.
      const a = byId.get(cardA.id as string);
      expect(a?.finalize_run).not.toBeNull();
      expect(a?.finalize_run?.id).toBe('run-new-' + (cardA.id as string));
      expect(a?.finalize_run?.status).toBe('reviewing');
      expect(a?.finalize_run?.session_id).toBe(sessionWithRun.id);

      // Card B — session present, no finalize history.
      const b = byId.get(cardB.id as string);
      expect(b?.session_id).toBe(sessionNoRun.id);
      expect(b?.finalize_run).toBeNull();

      // Card C — no session at all.
      const c = byId.get(cardC.id as string);
      expect(c?.session_id).toBeNull();
      expect(c?.finalize_run).toBeNull();
    });
  });

  describe('Cards CRUD', () => {
    it('creates a card', async () => {
      const card = await createCard(testProject.id as string, {
        title: 'Test Task',
        priority: 'high',
      });
      expect(card.title).toBe('Test Task');
      expect(card.priority).toBe('high');
      expect(card).toHaveProperty('id');
    });

    it('does not create a card when assignedUserId is invalid', async () => {
      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const columnId = (boardRes.body.columns as Array<{ id: string }>)[0]!.id;
      const title = 'Invalid card assignee should not persist';

      await request
        .post(`/api/projects/${testProject.id}/board/cards`)
        .send({ title, columnId, assignedUserId: 'missing-user' })
        .expect(400);

      const cardsRes = await request.get(`/api/projects/${testProject.id}/board/cards`).expect(200);
      expect((cardsRes.body as Array<{ title: string }>).some((card) => card.title === title)).toBe(
        false,
      );
    });

    it('lists cards for a project', async () => {
      await createCard(testProject.id as string);
      const res = await request.get(`/api/projects/${testProject.id}/board/cards`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('updates a card', async () => {
      const card = await createCard(testProject.id as string);
      const res = await request
        .put(`/api/projects/${testProject.id}/board/cards/${card.id}`)
        .send({ title: 'Updated Title', priority: 'urgent' })
        .expect(200);

      expect(res.body.title).toBe('Updated Title');
      expect(res.body.priority).toBe('urgent');
    });

    it('does not update a card when assignedUserId is invalid', async () => {
      const card = await createCard(testProject.id as string, { title: 'Keep Card Title' });

      await request
        .put(`/api/projects/${testProject.id}/board/cards/${card.id}`)
        .send({ title: 'Changed Card Title', assignedUserId: 'missing-user' })
        .expect(400);

      const cardsRes = await request.get(`/api/projects/${testProject.id}/board/cards`).expect(200);
      const current = (cardsRes.body as Array<{ id: string; title: string }>).find(
        (row) => row.id === card.id,
      );
      expect(current?.title).toBe('Keep Card Title');
    });

    it('moves a card between columns', async () => {
      const card = await createCard(testProject.id as string);
      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const doneCol = (boardRes.body.columns as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'Done',
      )!;

      const res = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/move`)
        .send({ columnId: doneCol.id })
        .expect(200);

      expect(res.body.column_id).toBe(doneCol.id);
    });

    it('deletes a card', async () => {
      const card = await createCard(testProject.id as string);
      await request.delete(`/api/projects/${testProject.id}/board/cards/${card.id}`).expect(200);
    });
  });

  describe('Card Comments', () => {
    it('creates and lists comments on a card', async () => {
      const card = await createCard(testProject.id as string);

      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .send({ author: 'test-agent', content: 'Working on this.' })
        .expect(200);

      expect(Array.isArray(createRes.body)).toBe(true);
      expect(createRes.body.length).toBe(1);
      expect(createRes.body[0].content).toBe('Working on this.');

      const res = await request
        .get(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .expect(200);

      expect(res.body.length).toBe(1);
    });

    it('deletes a comment', async () => {
      const card = await createCard(testProject.id as string);
      const commentRes = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .send({ author: 'test', content: 'Delete me' })
        .expect(200);

      const commentId = (commentRes.body as Array<{ id: string }>)[0].id;
      await request
        .delete(`/api/projects/${testProject.id}/board/cards/${card.id}/comments/${commentId}`)
        .expect(200);
    });
  });

  describe('Epics', () => {
    it('creates and lists epics', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Test Epic', description: 'Epic description', color: '#3B82F6' })
        .expect(200);

      expect(res.body.name).toBe('Test Epic');
      expect(res.body).toHaveProperty('id');

      const listRes = await request.get(`/api/projects/${testProject.id}/board/epics`).expect(200);
      expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    });

    it('does not create an epic when assignedUserId is invalid', async () => {
      const name = 'Invalid Assignee Epic';
      await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name, assignedUserId: 'missing-user' })
        .expect(400);

      const listRes = await request.get(`/api/projects/${testProject.id}/board/epics`).expect(200);
      expect((listRes.body as Array<{ name: string }>).some((epic) => epic.name === name)).toBe(
        false,
      );
    });

    it('does not update an epic when assignedUserId is invalid', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Keep Name', color: '#3B82F6' })
        .expect(200);
      const epicId = (epicRes.body as { id: string }).id;

      await request
        .put(`/api/projects/${testProject.id}/board/epics/${epicId}`)
        .send({ name: 'Changed Name', assignedUserId: 'missing-user' })
        .expect(400);

      const listRes = await request.get(`/api/projects/${testProject.id}/board/epics`).expect(200);
      const epic = (listRes.body as Array<{ id: string; name: string }>).find(
        (row) => row.id === epicId,
      );
      expect(epic?.name).toBe('Keep Name');
    });

    it('persists epic orchestrationBudgets JSON and clears with null', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Budget Epic', color: '#222222' })
        .expect(200);
      const epicId = (epicRes.body as { id: string }).id;

      const withBudgets = await request
        .put(`/api/projects/${testProject.id}/board/epics/${epicId}`)
        .send({
          orchestrationBudgets: { maxContinuationDepth: 2, maxReactWallClockMs: 900 },
        })
        .expect(200);

      const rawJson = (withBudgets.body as { orchestration_budgets_json?: string | null })
        .orchestration_budgets_json;
      expect(rawJson).toBeTruthy();
      const stored = JSON.parse(String(rawJson)) as Record<string, number>;
      expect(stored.maxContinuationDepth).toBe(2);
      expect(stored.maxReactWallClockMs).toBe(900);

      const cleared = await request
        .put(`/api/projects/${testProject.id}/board/epics/${epicId}`)
        .send({ orchestrationBudgets: null })
        .expect(200);

      const after = (cleared.body as { orchestration_budgets_json?: string | null })
        .orchestration_budgets_json;
      expect(after == null || after === '').toBe(true);
    });

    it('clears epic orchestration_budgets_json when payload has no recognized keys', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Sanitize Epic', color: '#333333' })
        .expect(200);
      const epicId = (epicRes.body as { id: string }).id;

      await request
        .put(`/api/projects/${testProject.id}/board/epics/${epicId}`)
        .send({ orchestrationBudgets: { maxReactWallClockMs: 111 } })
        .expect(200);

      const clearedUnknown = await request
        .put(`/api/projects/${testProject.id}/board/epics/${epicId}`)
        .send({ orchestrationBudgets: { totallyUnknown: 99 } })
        .expect(200);
      const raw = (clearedUnknown.body as { orchestration_budgets_json?: string | null })
        .orchestration_budgets_json;
      expect(raw == null || raw === '').toBe(true);
    });

    it('links a card to an epic', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Link Test', color: '#FF0000' })
        .expect(200);

      const card = await createCard(testProject.id as string);
      const res = await request
        .put(`/api/projects/${testProject.id}/board/cards/${card.id}`)
        .send({ epicId: epicRes.body.id })
        .expect(200);

      expect(res.body.epic_id).toBe(epicRes.body.id);
    });

    it('deletes an epic', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Delete Me', color: '#FF0000' })
        .expect(200);

      await request
        .delete(`/api/projects/${testProject.id}/board/epics/${epicRes.body.id}`)
        .expect(200);
    });
  });

  describe('Columns', () => {
    it('creates a custom column', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'QA' })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const qa = (res.body as Array<{ name: string }>).find((c) => c.name === 'QA');
      expect(qa).toBeDefined();
    });

    it('rejects creating a duplicate system column name', async () => {
      const before = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const beforeDoneColumns = (before.body.columns as Array<{ name: string }>).filter(
        (c) => c.name === 'Done',
      );

      const res = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Done' })
        .expect(400);

      expect(res.body.error).toMatch(/duplicate system column/i);

      const after = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const afterDoneColumns = (after.body.columns as Array<{ name: string }>).filter(
        (c) => c.name === 'Done',
      );
      expect(afterDoneColumns).toHaveLength(beforeDoneColumns.length);
    });

    it('updates a column name', async () => {
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Temp Col' })
        .expect(200);

      const tempCol = (
        createRes.body as Array<{ id: string; name: string; position: number }>
      ).find((c) => c.name === 'Temp Col')!;

      const res = await request
        .put(`/api/projects/${testProject.id}/board/columns/${tempCol.id}`)
        .send({ name: 'Renamed Col', position: tempCol.position })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('rejects renaming a custom column to a system column name', async () => {
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Rename Guard' })
        .expect(200);

      const customCol = (
        createRes.body as Array<{ id: string; name: string; position: number }>
      ).find((c) => c.name === 'Rename Guard')!;

      const res = await request
        .put(`/api/projects/${testProject.id}/board/columns/${customCol.id}`)
        .send({ name: 'In Progress', position: customCol.position })
        .expect(400);

      expect(res.body.error).toMatch(/system column name/i);

      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const unchanged = (boardRes.body.columns as Array<{ id: string; name: string }>).find(
        (c) => c.id === customCol.id,
      );
      expect(unchanged?.name).toBe('Rename Guard');
    });

    it('reorders columns atomically with a complete ordered id list', async () => {
      await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'QA Reorder' })
        .expect(200);

      const before = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const orderedBefore = [
        ...(before.body.columns as Array<{ id: string; name: string; position: number }>),
      ].sort((a, b) => a.position - b.position);
      const nextIds = orderedBefore.map((column) => column.id).reverse();

      const res = await request
        .post(`/api/projects/${testProject.id}/board/columns/reorder`)
        .send({ columnIds: nextIds })
        .expect(200);

      const reordered = res.body as Array<{ id: string; position: number }>;
      expect(reordered.map((column) => column.id)).toEqual(nextIds);
      expect(reordered.map((column) => column.position)).toEqual(nextIds.map((_, index) => index));
      expect(new Set(reordered.map((column) => column.position)).size).toBe(reordered.length);
    });

    it('rejects column reorder payloads that omit a board column', async () => {
      await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'QA Partial Reorder' })
        .expect(200);

      const before = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const orderedBefore = [
        ...(before.body.columns as Array<{ id: string; position: number }>),
      ].sort((a, b) => a.position - b.position);

      const res = await request
        .post(`/api/projects/${testProject.id}/board/columns/reorder`)
        .send({ columnIds: orderedBefore.slice(0, -1).map((column) => column.id) })
        .expect(400);

      expect(res.body.error).toMatch(/every board column exactly once/i);

      const after = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const orderedAfter = [
        ...(after.body.columns as Array<{ id: string; position: number }>),
      ].sort((a, b) => a.position - b.position);
      expect(orderedAfter.map((column) => [column.id, column.position])).toEqual(
        orderedBefore.map((column) => [column.id, column.position]),
      );
    });

    it('deletes a column', async () => {
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Delete Me Col' })
        .expect(200);

      const delCol = (createRes.body as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'Delete Me Col',
      )!;

      await request
        .delete(`/api/projects/${testProject.id}/board/columns/${delCol.id}`)
        .expect(200);
    });

    it('rejects deleting a column that still has cards', async () => {
      // Use a custom (non-system) column so the card-count guard is exercised
      // rather than short-circuiting on the system-column lock (To Do/In
      // Progress/Done can never be deleted regardless of contents).
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Blocked' })
        .expect(200);
      const customCol = (createRes.body as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'Blocked',
      )!;

      await request
        .post(`/api/projects/${testProject.id}/board/cards`)
        .send({ title: 'Block delete', columnId: customCol.id })
        .expect(200);

      const res = await request
        .delete(`/api/projects/${testProject.id}/board/columns/${customCol.id}`)
        .expect(400);

      expect(res.body.error).toMatch(/still contains cards/i);
    });

    it('rejects deleting a system column', async () => {
      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const todoCol = (boardRes.body.columns as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'To Do',
      )!;

      const res = await request
        .delete(`/api/projects/${testProject.id}/board/columns/${todoCol.id}`)
        .expect(400);

      expect(res.body.error).toMatch(/system column/i);
    });

    it('rejects renaming a system column', async () => {
      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const doneCol = (
        boardRes.body.columns as Array<{ id: string; name: string; position: number }>
      ).find((c) => c.name === 'Done')!;

      const res = await request
        .put(`/api/projects/${testProject.id}/board/columns/${doneCol.id}`)
        .send({ name: 'Complete', position: doneCol.position })
        .expect(400);

      expect(res.body.error).toMatch(/system column/i);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Wiki
// ═══════════════════════════════════════════════════════════════════

describe('Wiki', () => {
  let testProject: Record<string, unknown>;

  beforeAll(async () => {
    testProject = await createProject();
  });

  describe('POST /api/projects/:projectId/wiki', () => {
    it('creates a wiki page', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/wiki`)
        .send({
          title: 'Getting Started',
          content: '# Getting Started\n\nWelcome!',
          category: 'onboarding',
          updatedBy: 'test-agent',
        })
        .expect(201);

      expect(res.body.title).toBe('Getting Started');
      expect(res.body.slug).toBe('getting-started');
      expect(res.body.category).toBe('onboarding');
    });

    it('rejects page without title', async () => {
      await request
        .post(`/api/projects/${testProject.id}/wiki`)
        .send({ content: 'No title' })
        .expect(400);
    });
  });

  describe('GET /api/projects/:projectId/wiki', () => {
    it('lists all wiki pages', async () => {
      await createWikiPage(testProject.id as string);
      const res = await request.get(`/api/projects/${testProject.id}/wiki`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('searches wiki pages by query', async () => {
      await createWikiPage(testProject.id as string, {
        title: 'Unique Search Term XYZ',
        content: 'Findable content',
      });
      const res = await request.get(`/api/projects/${testProject.id}/wiki?q=XYZ`).expect(200);

      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/projects/:projectId/wiki/:slug', () => {
    it('returns a wiki page by slug', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Slug Test Page' });
      const res = await request
        .get(`/api/projects/${testProject.id}/wiki/${page.slug}`)
        .expect(200);

      expect(res.body.title).toBe('Slug Test Page');
      expect(res.body.content).toContain('Test');
    });

    it('returns 404 for nonexistent page', async () => {
      await request.get(`/api/projects/${testProject.id}/wiki/does-not-exist`).expect(404);
    });
  });

  describe('PUT /api/projects/:projectId/wiki/:slug', () => {
    it('updates a wiki page', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Update Me' });
      const res = await request
        .put(`/api/projects/${testProject.id}/wiki/${page.slug}`)
        .send({ content: '# Updated Content', updatedBy: 'test-agent' })
        .expect(200);

      expect(res.body.content).toBe('# Updated Content');
    });
  });

  describe('DELETE /api/projects/:projectId/wiki/:slug', () => {
    it('deletes a wiki page', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Delete Me' });
      await request.delete(`/api/projects/${testProject.id}/wiki/${page.slug}`).expect(200);

      await request.get(`/api/projects/${testProject.id}/wiki/${page.slug}`).expect(404);
    });
  });

  describe('GET /api/projects/:projectId/wiki/categories', () => {
    it('returns list of valid categories', async () => {
      const res = await request.get(`/api/projects/${testProject.id}/wiki/categories`).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('general');
      expect(res.body).toContain('api-docs');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Crons
// ═══════════════════════════════════════════════════════════════════

describe('Crons', () => {
  describe('GET /api/crons', () => {
    it('lists all crons', async () => {
      const res = await request.get('/api/crons').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('CRUD lifecycle', () => {
    it('creates, updates, and deletes a cron', async () => {
      const createRes = await request
        .post('/api/crons')
        .send({ name: 'Test Cron', schedule: '0 * * * *', prompt: 'echo hello', cwd: '/tmp' })
        .expect(200);

      expect(createRes.body).toHaveProperty('id');
      const id = createRes.body.id as number;

      const updateRes = await request
        .put(`/api/crons/${id}`)
        .send({ name: 'Updated Cron', schedule: '*/5 * * * *' })
        .expect(200);
      expect(updateRes.body.name).toBe('Updated Cron');

      await request.get(`/api/crons/${id}/logs`).expect(200);

      await request.delete(`/api/crons/${id}`).expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Heartbeats
// ═══════════════════════════════════════════════════════════════════

describe('Heartbeats', () => {
  describe('GET /api/heartbeats', () => {
    it('lists heartbeat configs', async () => {
      const res = await request.get('/api/heartbeats').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/heartbeats/state', () => {
    it('returns heartbeat state', async () => {
      const res = await request.get('/api/heartbeats/state').expect(200);
      expect(typeof res.body).toBe('object');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Multi-agent sessions
// ═══════════════════════════════════════════════════════════════════

describe('Session advisors', () => {
  it('adds advisor from a different project than the session executor', async () => {
    const projA = await createProject({ name: 'Project A' });
    const projB = await createProject({ name: 'Project B' });
    const executor = await createAgent({ projectId: projA.id as string, name: 'Exec A' });
    const advisor = await createAgent({ projectId: projB.id as string, name: 'Advisor B' });

    const sessionRes = await request
      .post(`/api/agents/${executor.id}/sessions`)
      .send({ name: 'Cross-project multi' })
      .expect(200);
    const sessionId = sessionRes.body.id as string;

    await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId: advisor.id })
      .expect(200);

    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    const advisorRow = (
      detail.body.agents as Array<{ id: string; role: string; projectId?: string }>
    ).find((a) => a.id === advisor.id);
    expect(advisorRow?.role).toBe('advisor');
    expect(advisorRow?.projectId).toBe(projB.id);
  });

  it('adds and removes advisor agents on a session', async () => {
    const agent = await createAgent();
    const advisor = await createAgent();

    const sessionRes = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'Multi test' })
      .expect(200);
    const sessionId = sessionRes.body.id as string;

    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(detail.body.agents).toBeTruthy();
    expect((detail.body.agents as Array<{ role: string }>).some((a) => a.role === 'executor')).toBe(
      true,
    );

    await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId: advisor.id })
      .expect(200);

    const withAdvisor = await request.get(`/api/sessions/${sessionId}`).expect(200);
    const agentIds = (withAdvisor.body.agents as Array<{ id: string }>).map((a) => a.id);
    expect(agentIds).toContain(advisor.id);

    await request.delete(`/api/sessions/${sessionId}/agents/${advisor.id}`).expect(200);

    const afterRemove = await request.get(`/api/sessions/${sessionId}`).expect(200);
    const afterIds = (afterRemove.body.agents as Array<{ id: string }>).map((a) => a.id);
    expect(afterIds).not.toContain(advisor.id);
  });

  it('PATCH accepts max_turns', async () => {
    const agent = await createAgent();
    const sessionRes = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'Turns test' })
      .expect(200);
    const sessionId = sessionRes.body.id as string;

    const patched = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ max_turns: 3 })
      .expect(200);
    expect(patched.body.max_turns).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════

describe('Config', () => {
  describe('GET /api/config', () => {
    it('returns server configuration', async () => {
      const res = await request.get('/api/config').expect(200);
      expect(res.body).toHaveProperty('port');
      expect(res.body).toHaveProperty('authRequired');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Device tokens
// ═══════════════════════════════════════════════════════════════════

describe('Device Tokens', () => {
  it('registers and unregisters a device token', async () => {
    await request
      .post('/api/devices')
      .send({ token: 'test-token-abc', platform: 'ios' })
      .expect(200);

    await request.delete('/api/devices/test-token-abc').expect(200);
  });

  it('rejects registration without token', async () => {
    await request.post('/api/devices').send({ platform: 'ios' }).expect(400);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Slack
// ═══════════════════════════════════════════════════════════════════

describe('Slack', () => {
  describe('GET /api/slack/status', () => {
    it('returns slack connection status', async () => {
      const res = await request.get('/api/slack/status').expect(200);
      expect(typeof res.body).toBe('object');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Active Tasks
// ═══════════════════════════════════════════════════════════════════

describe('Active Tasks', () => {
  describe('GET /api/active-tasks', () => {
    it('returns active tasks list', async () => {
      const res = await request.get('/api/active-tasks').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Background Tasks
// ═══════════════════════════════════════════════════════════════════

describe('Background Tasks', () => {
  describe('GET /api/tasks', () => {
    it('returns task list', async () => {
      const res = await request.get('/api/tasks').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/tasks/:taskId', () => {
    it('returns 404 for nonexistent task', async () => {
      await request.get('/api/tasks/nonexistent-task-id').expect(404);
    });

    // Guards the Phase-2 async-DB migration: the task-detail handler loads the
    // session transcript through the async reader facade (readAll). Seed a task
    // + session + messages directly and assert the response carries the full
    // ordered transcript unchanged.
    it('returns the task with its full transcript via the async reader path', async () => {
      const agent = await createAgent();
      const session = await createSession({ agentId: agent.id as string, name: 'BG' });
      const sessionId = session.id as string;
      const { getDb } = await import('../db.js');
      const db = getDb();
      const taskId = 'task-async-read';
      db.prepare(
        `INSERT INTO background_tasks (id, session_id, agent_id, prompt) VALUES (?, ?, ?, ?)`,
      ).run(taskId, sessionId, agent.id as string, 'do the thing');
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('bgm1', sessionId, 'user', 'a', '2026-04-01T00:00:00.000Z');
      insert.run('bgm2', sessionId, 'assistant', 'b', '2026-04-01T00:01:00.000Z');

      const res = await request.get(`/api/tasks/${taskId}`).expect(200);
      expect(res.body.id).toBe(taskId);
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['bgm1', 'bgm2']);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════════════════

describe('Usage', () => {
  describe('GET /api/usage', () => {
    it('returns usage statistics', async () => {
      const res = await request.get('/api/usage').expect(200);
      expect(res.body).toHaveProperty('totals');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════

describe('Setup', () => {
  describe('GET /api/setup/status', () => {
    it('returns setup status including engine paths', async () => {
      const res = await request.get('/api/setup/status').expect(200);
      expect(res.body).toHaveProperty('firstRun');
      // hasAnyAiCredentials drives the SetupWizard "no creds" trigger in
      // App.jsx — must always be present (boolean) regardless of host state.
      expect(res.body).toHaveProperty('hasAnyAiCredentials');
      expect(typeof res.body.hasAnyAiCredentials).toBe('boolean');
      // authConfigured is the authoritative "needs first-run wizard"
      // signal — it must always be present so the client can gate on it
      // without falling back to the unreliable orgs / host-creds heuristic.
      expect(res.body).toHaveProperty('authConfigured');
      expect(typeof res.body.authConfigured).toBe('boolean');
      expect(res.body.engineAuth).toEqual(
        expect.objectContaining({
          'claude-code': expect.any(Boolean),
          'cursor-agent': expect.any(Boolean),
          'codex-cli': expect.any(Boolean),
        }),
      );
      expect(res.body.engines).toEqual(
        expect.objectContaining({
          'claude-code': expect.objectContaining({
            path: expect.any(String),
          }),
          'cursor-agent': expect.objectContaining({
            path: expect.any(String),
          }),
          'codex-cli': expect.objectContaining({
            path: expect.any(String),
          }),
          // Grok is a first-class CLI engine offered in the setup wizard, so
          // it must appear in the engines map (with availability + path)
          // alongside the others. Regression guard for the wizard's Grok card.
          'grok-cli': expect.objectContaining({
            path: expect.any(String),
            available: expect.any(Boolean),
            authenticated: expect.any(Boolean),
          }),
        }),
      );
    });
  });

  describe('POST /api/setup/configure', () => {
    it('round-trips cursorBin and codexBin and GET status engines stay serializable', async () => {
      const beforeCfg = await request.get('/api/config').expect(200);
      const restoreCursorBin = beforeCfg.body.cursorBin as string;
      const restoreCodexBin = beforeCfg.body.codexBin as string;

      const suffix = `${Date.now()}-${++_uniqueCounter}`;
      const cursorBin = `/tmp/agent-hub-setup-cursor-${suffix}`;
      const codexBin = `/tmp/agent-hub-setup-codex-${suffix}`;

      try {
        await request.post('/api/setup/configure').send({ cursorBin, codexBin }).expect(200);

        const cfg = await request.get('/api/config').expect(200);
        expect(cfg.body.cursorBin).toBe(cursorBin);
        expect(cfg.body.codexBin).toBe(codexBin);

        const status = await request.get('/api/setup/status').expect(200);
        expect(status.body.engines['cursor-agent'].path).toBe(cursorBin);
        expect(status.body.engines['codex-cli'].path).toBe(codexBin);
        expect(typeof status.body.engines['cursor-agent'].available).toBe('boolean');
        expect(typeof status.body.engines['codex-cli'].available).toBe('boolean');
      } finally {
        await request
          .patch('/api/config')
          .send({ cursorBin: restoreCursorBin, codexBin: restoreCodexBin })
          .expect(200);
      }
    });

    it('round-trips grokBin so the wizard can enable the Grok engine', async () => {
      const beforeCfg = await request.get('/api/config').expect(200);
      const restoreGrokBin = beforeCfg.body.grokBin as string;

      const suffix = `${Date.now()}-${++_uniqueCounter}`;
      const grokBin = `/tmp/agent-hub-setup-grok-${suffix}`;

      try {
        await request.post('/api/setup/configure').send({ grokBin }).expect(200);

        const cfg = await request.get('/api/config').expect(200);
        expect(cfg.body.grokBin).toBe(grokBin);

        const status = await request.get('/api/setup/status').expect(200);
        expect(status.body.engines['grok-cli'].path).toBe(grokBin);
        expect(typeof status.body.engines['grok-cli'].available).toBe('boolean');
      } finally {
        await request.patch('/api/config').send({ grokBin: restoreGrokBin }).expect(200);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session Queue & Delegations
// ═══════════════════════════════════════════════════════════════════

describe('Session Queue', () => {
  it('returns queue for a session', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/queue`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Delegations', () => {
  it('returns delegations for a session', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/delegations`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Threads
// ═══════════════════════════════════════════════════════════════════

describe('Threads', () => {
  let project: Record<string, unknown>;

  beforeAll(async () => {
    project = await createProject();
  });

  describe('POST /api/projects/:projectId/threads', () => {
    it('creates a cron thread', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Daily backup', type: 'cron', source_id: 'cron-123' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Daily backup');
      expect(res.body.type).toBe('cron');
      expect(res.body.source_id).toBe('cron-123');
      expect(res.body.project_id).toBe(project.id);
      expect(res.body.created_at).toBeDefined();
    });

    it('creates a heartbeat thread', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Agent check-in', type: 'heartbeat' })
        .expect(201);

      expect(res.body.type).toBe('heartbeat');
    });

    it('rejects missing name', async () => {
      await request.post(`/api/projects/${project.id}/threads`).send({ type: 'cron' }).expect(400);
    });

    it('rejects invalid type', async () => {
      await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Bad', type: 'invalid' })
        .expect(400);
    });

    it('returns 404 for unknown project', async () => {
      await request
        .post('/api/projects/nonexistent/threads')
        .send({ name: 'Test', type: 'cron' })
        .expect(404);
    });
  });

  describe('GET /api/projects/:projectId/threads', () => {
    it('lists threads for a project', async () => {
      const proj = await createProject();
      await createThread(proj.id as string, { name: 'Thread A', type: 'cron' });
      await createThread(proj.id as string, { name: 'Thread B', type: 'heartbeat' });

      const res = await request.get(`/api/projects/${proj.id}/threads`).expect(200);
      expect(res.body.length).toBe(2);
    });

    it('filters by type', async () => {
      const proj = await createProject();
      await createThread(proj.id as string, { name: 'Cron 1', type: 'cron' });
      await createThread(proj.id as string, { name: 'HB 1', type: 'heartbeat' });

      const res = await request.get(`/api/projects/${proj.id}/threads?type=heartbeat`).expect(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].type).toBe('heartbeat');
    });
  });

  describe('GET /api/threads/:threadId', () => {
    it('returns a single thread', async () => {
      const thread = await createThread(project.id as string);
      const res = await request.get(`/api/threads/${thread.id}`).expect(200);
      expect(res.body.id).toBe(thread.id);
    });

    it('returns 404 for unknown thread', async () => {
      await request.get('/api/threads/nonexistent').expect(404);
    });
  });

  describe('DELETE /api/threads/:threadId', () => {
    it('deletes a thread', async () => {
      const thread = await createThread(project.id as string);
      await request.delete(`/api/threads/${thread.id}`).expect(200);
      await request.get(`/api/threads/${thread.id}`).expect(404);
    });

    it('returns 404 for unknown thread', async () => {
      await request.delete('/api/threads/nonexistent').expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Thread Entries
// ═══════════════════════════════════════════════════════════════════

describe('Thread Entries', () => {
  let project: Record<string, unknown>;

  beforeAll(async () => {
    project = await createProject();
  });

  describe('POST /api/threads/:threadId/entries', () => {
    it('creates an entry', async () => {
      const thread = await createThread(project.id as string);
      const res = await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Cron started' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.thread_id).toBe(thread.id);
      expect(res.body.content).toBe('Cron started');
      expect(res.body.timestamp).toBeDefined();
    });

    it('rejects missing content', async () => {
      const thread = await createThread(project.id as string);
      await request.post(`/api/threads/${thread.id}/entries`).send({}).expect(400);
    });

    it('returns 404 for unknown thread', async () => {
      await request.post('/api/threads/nonexistent/entries').send({ content: 'test' }).expect(404);
    });
  });

  describe('GET /api/threads/:threadId/entries', () => {
    it('lists entries in chronological order', async () => {
      const thread = await createThread(project.id as string);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'First' })
        .expect(201);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Second' })
        .expect(201);

      const res = await request.get(`/api/threads/${thread.id}/entries`).expect(200);
      expect(res.body.length).toBe(2);
      expect(res.body[0].content).toBe('First');
      expect(res.body[1].content).toBe('Second');
    });

    it('returns 404 for unknown thread', async () => {
      await request.get('/api/threads/nonexistent/entries').expect(404);
    });
  });

  describe('cascade delete', () => {
    it('deleting a thread removes its entries', async () => {
      const thread = await createThread(project.id as string);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Will be deleted' })
        .expect(201);

      await request.delete(`/api/threads/${thread.id}`).expect(200);
      await request.get(`/api/threads/${thread.id}/entries`).expect(404);
    });
  });
});
