/**
 * Integration tests for the AI RUM setup wizard routes.
 *
 *   GET  /api/projects/:projectId/rum/setup-draft     (Admin+)
 *   POST /api/projects/:projectId/rum/setup-wizard    (Admin+)
 *   POST /api/projects/:projectId/rum/setup-apply     (Admin+)
 *
 * Covers:
 *   - role gate (403 for a User-role caller) on the routes
 *   - 404 when the project does not exist
 *   - GET happy path returns { projectId, draft } with detected framework
 *   - POST 400 when the project has no agents to host the wizard
 *   - POST happy path spawns a worktree-backed session and returns
 *     { sessionId, agentId, draft, session }
 *   - buildRumKickoffPrompt embeds the draft, bound values, and rum-setup
 *     skill, and surfaces the framework-specific injection style
 *   - setup-apply: validateInstrumentationFiles rejects bad input
 *   - setup-apply: 400 when no worktree session exists, 400 on invalid
 *     files / missing file / nothing-to-commit, happy path stages + commits
 *     only the listed paths and returns sha + branch
 *
 * No real CLI binaries are spawned: the wizard's `handleChat` is
 * fire-and-forget and returns the synchronously-created session row before
 * any CLI spawn; server/test/setup.ts neutralises the forbidden binaries so
 * the downstream spawn attempt fails inside the chat handler's own promise
 * without affecting the supertest response. The setup-apply tests drive a
 * real temp git repo with `git add` / `git commit` (no CLI binaries).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import './setup.js';
import {
  buildRumKickoffPrompt,
  isRumSetupWizardSession,
  validateInstrumentationFilesShape,
  resolveInstrumentationFiles,
} from '../routes/rum-wizard.js';
import type { RumSetupDraft } from '../rum-setup-draft.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getDb } from '../db.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'rum-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `rum-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `rum-wizard-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

let _counter = 0;
function uid(prefix = 'rum-wizard'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(cwd: string): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd, color: '#3B82F6' })
    .expect(201);
  return (res.body as { id: string }).id;
}

async function makeAgent(projectId: string): Promise<string> {
  const id = uid('agent');
  const res = await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, projectId, name: `Agent ${id}`, engine: 'claude-code' })
    .expect(201);
  return (res.body as { id: string }).id;
}

/** Lay down a minimal Next.js app-router project under a temp cwd. */
function makeNextAppCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ah-rum-cwd-'));
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { next: '14.0.0', react: '18.2.0' } }),
  );
  writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
  mkdirSync(path.join(cwd, 'app'), { recursive: true });
  writeFileSync(path.join(cwd, 'app', 'layout.tsx'), 'export default function L() {}');
  return cwd;
}

describe('GET /api/projects/:projectId/rum/setup-draft', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .get('/api/projects/any-id/rum/setup-draft')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/no-such-project/rum/setup-draft')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it('happy path returns the detection draft for a Next.js app', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .get(`/api/projects/${projectId}/rum/setup-draft`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.draft.framework).toBe('next');
    expect(res.body.draft.packageManager).toBe('npm');
    expect(res.body.draft.typescript).toBe(true);
    expect(res.body.draft.plan.targetFile).toBe('app/layout.tsx');
    // Next app-router layout is a Server Component → client-component insertion.
    expect(res.body.draft.plan.injectionStyle).toBe('client-component');
  });
});

describe('POST /api/projects/:projectId/rum/setup-wizard', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/rum/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/rum/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('400 when the project has no agents to host the wizard', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a worktree-backed session with the draft embedded', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);

    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBe(res.body.sessionId);
    // Worktree-backed so the agent can author edits on its own branch and
    // use Finalize Code Changes for review/push.
    expect(res.body.session.use_worktree).toBe(1);
    expect(res.body.session.ask_mode).toBe(0);
    expect(isRumSetupWizardSession(res.body.session)).toBe(true);
    expect(res.body.session.name).toMatch(/RUM Setup/);
    // The detection draft rides along in the response and the kickoff.
    expect(res.body.draft.framework).toBe('next');
    expect(res.body.draft.plan.injectionStyle).toBe('client-component');
    expect(res.body.draft.plan.targetFile).toBe('app/layout.tsx');
  });
});

describe('buildRumKickoffPrompt', () => {
  const draft: RumSetupDraft = {
    framework: 'next',
    frameworkEvidence: ['next'],
    packageManager: 'npm',
    typescript: true,
    entryCandidates: [{ path: 'app/layout.tsx', kind: 'root-layout' }],
    cspHits: [{ path: 'next.config.js', source: 'header' }],
    recorder: { dependencyPresent: false, initDetected: false },
    plan: {
      alreadyInstrumented: false,
      targetFile: 'app/layout.tsx',
      injectionStyle: 'client-component',
      recommendedConnectSrc: 'https://hub.example.com',
      notes: ['Next app-router layout is a Server Component'],
    },
    readme: {
      readmePath: null,
      setupExcerpt: null,
      hasDockerHints: false,
      envKeysFromReadme: [],
    },
  };

  it('embeds bound values, the draft JSON, and the rum-setup skill', () => {
    const prompt = buildRumKickoffPrompt('proj-1', '/tmp/work', draft, 'sess-1');
    expect(prompt).toContain('PROJECT_ID');
    expect(prompt).toContain('proj-1');
    expect(prompt).toContain('/tmp/work');
    expect(prompt).toContain('sess-1');
    // Full draft is embedded so the agent does not re-scan.
    expect(prompt).toContain('"injectionStyle": "client-component"');
    expect(prompt).toContain('app/layout.tsx');
    // Skill is loaded for the framework-specific walkthrough.
    expect(prompt).toContain('<agenthub:skill>');
    expect(prompt).toContain('"name":"rum-setup"');
    // Surfaces the detected injection style and target in the summary.
    expect(prompt).toContain('client-component');
  });

  it('flags an undetermined target when nothing was detected', () => {
    const prompt = buildRumKickoffPrompt(
      'p',
      '/c',
      {
        ...draft,
        plan: { ...draft.plan, targetFile: null, injectionStyle: null },
      },
      's',
    );
    expect(prompt).toContain('none detected');
  });

  it('instructs the agent to commit via rum/setup-apply with the session id', () => {
    const prompt = buildRumKickoffPrompt('proj-9', '/tmp/work', draft, 'sess-9');
    expect(prompt).toContain('/rum/setup-apply');
    // The bound session id rides into the apply payload example.
    expect(prompt).toContain('sess-9');
    expect(prompt).toContain('"files"');
  });
});

describe('validateInstrumentationFilesShape', () => {
  it('rejects a non-array or empty list (no worktree needed)', () => {
    expect(validateInstrumentationFilesShape(undefined).ok).toBe(false);
    expect(validateInstrumentationFilesShape([]).ok).toBe(false);
    expect(validateInstrumentationFilesShape('app/layout.tsx').ok).toBe(false);
  });

  it('rejects blank, absolute, and traversal paths', () => {
    expect(validateInstrumentationFilesShape(['']).ok).toBe(false);
    expect(validateInstrumentationFilesShape(['  ']).ok).toBe(false);
    expect(validateInstrumentationFilesShape(['/etc/passwd']).ok).toBe(false);
    expect(validateInstrumentationFilesShape(['../escape.ts']).ok).toBe(false);
    expect(validateInstrumentationFilesShape(['app/../../escape.ts']).ok).toBe(false);
  });

  it('accepts shape-valid relative paths (trimmed, not yet root-resolved)', () => {
    const out = validateInstrumentationFilesShape([' app/layout.tsx ', 'app/rum-recorder.tsx']);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.files).toEqual(['app/layout.tsx', 'app/rum-recorder.tsx']);
    }
  });
});

describe('resolveInstrumentationFiles', () => {
  const root = '/tmp/work';

  it('normalizes and de-duplicates against the worktree root', () => {
    const out = resolveInstrumentationFiles(
      ['app/layout.tsx', './app/layout.tsx', 'app/rum-recorder.tsx'],
      root,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.files).toEqual(['app/layout.tsx', 'app/rum-recorder.tsx']);
    }
  });

  it('re-checks escape against the resolved root (defense in depth)', () => {
    expect(resolveInstrumentationFiles(['../escape.ts'], root).ok).toBe(false);
  });
});

/**
 * Spin up a temp git repo on a feature branch and seed a session whose
 * worktree_path/branch point at it. Single-branch repo (no actual linked
 * `git worktree add`) — setup-apply only needs a working git dir.
 */
function seedSessionWithRepo(agentId: string): {
  worktreeDir: string;
  sessionId: string;
  branch: string;
} {
  const worktreeDir = mkdtempSync(path.join(tmpdir(), 'ah-rum-wt-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: worktreeDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: worktreeDir });
  mkdirSync(path.join(worktreeDir, 'app'), { recursive: true });
  writeFileSync(path.join(worktreeDir, 'app', 'layout.tsx'), 'export default function L() {}\n');
  execFileSync('git', ['add', '.'], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: worktreeDir });
  const branch = 'agent-hub/rum/session-test';
  execFileSync('git', ['checkout', '-b', branch], { cwd: worktreeDir });

  const sessionId = uid('sess-rum-wt');
  getDb()
    .prepare(
      'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, ask_mode, worktree_path, worktree_branch, wiki_hybrid_rag_budget_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      agentId,
      '[RUM Setup] card session',
      'claude-code',
      'claude-sonnet-4-5',
      1,
      0,
      worktreeDir,
      branch,
      1,
    );
  return { worktreeDir, sessionId, branch };
}

describe('POST /api/projects/:projectId/rum/setup-apply', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .post('/api/projects/any-id/rum/setup-apply')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ files: ['app/layout.tsx'] });
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/rum/setup-apply')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['app/layout.tsx'] });
    expect(res.status).toBe(404);
  });

  it('400 when no session with a worktree exists for the project', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    await makeAgent(projectId);
    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['app/layout.tsx'] })
      .expect(400);
    // cwd is not a git repo, so the auto-provision fallback can't bind either.
    expect(res.body.error).toBe('no_worktree');
  });

  it('400 invalid_files when files escape the worktree', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);
    const { sessionId } = seedSessionWithRepo(agentId);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['../../etc/passwd'], session_id: sessionId })
      .expect(400);
    expect(res.body.error).toBe('invalid_files');
  });

  it('rejects an empty files list before creating any [RUM Config] session', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: [] })
      .expect(400);
    // Shape validation runs BEFORE worktree resolution/provisioning, so the
    // error is invalid_files (not no_worktree) and — critically — no
    // throwaway session/branch was spawned as a side effect.
    expect(res.body.error).toBe('invalid_files');

    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(count.n).toBe(0);
  });

  it('400 not_a_file when a listed path is a directory', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);
    const { sessionId } = seedSessionWithRepo(agentId);

    // `app/` is a real directory in the seeded repo. Committing it would
    // sweep in every changed file under it — must be rejected.
    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['app'], session_id: sessionId })
      .expect(400);
    expect(res.body.error).toBe('not_a_file');
  });

  it('400 file_missing when a listed file is absent from the worktree', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);
    const { sessionId } = seedSessionWithRepo(agentId);

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['app/does-not-exist.tsx'], session_id: sessionId })
      .expect(400);
    expect(res.body.error).toBe('file_missing');
  });

  it('400 nothing_to_commit when the listed files have no changes', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);
    const { sessionId } = seedSessionWithRepo(agentId);

    // app/layout.tsx exists and is already committed (seed) with no edits.
    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ files: ['app/layout.tsx'], session_id: sessionId })
      .expect(400);
    expect(res.body.error).toBe('nothing_to_commit');
  });

  it('happy path: stages + commits only the listed instrumentation files', async () => {
    const cwd = makeNextAppCwd();
    const projectId = await makeProject(cwd);
    const agentId = await makeAgent(projectId);
    const { worktreeDir, sessionId, branch } = seedSessionWithRepo(agentId);

    // Wizard edits the recorder target, creates a client component, and
    // leaves an UNRELATED staged file that must NOT ride into the commit.
    writeFileSync(
      path.join(worktreeDir, 'app', 'layout.tsx'),
      "import './rum-recorder';\nexport default function L() {}\n",
    );
    writeFileSync(
      path.join(worktreeDir, 'app', 'rum-recorder.tsx'),
      "'use client';\nexport function RumRecorder() {}\n",
    );
    writeFileSync(path.join(worktreeDir, 'unrelated.txt'), 'pre-staged work\n');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: worktreeDir });

    const res = await request
      .post(`/api/projects/${projectId}/rum/setup-apply`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        files: ['app/layout.tsx', 'app/rum-recorder.tsx'],
        session_id: sessionId,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.files).toEqual(['app/layout.tsx', 'app/rum-recorder.tsx']);
    expect(res.body.branch).toBe(branch);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // The commit contains exactly the two instrumentation files.
    const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
      cwd: worktreeDir,
    })
      .toString()
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(committed).toEqual(['app/layout.tsx', 'app/rum-recorder.tsx']);

    // The unrelated pre-staged file stayed staged, never committed.
    const stillStaged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: worktreeDir,
    })
      .toString()
      .trim();
    expect(stillStaged).toBe('unrelated.txt');
  });
});
