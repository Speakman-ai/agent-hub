import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from './types.js';

const state = vi.hoisted(() => ({
  root: '',
  projects: [] as Project[],
  prefs: {} as Record<string, unknown>,
}));

vi.mock('./project-model.js', () => ({
  getProjects: () => state.projects,
  findProject: (id: string) => state.projects.find((p) => p.id === id) ?? null,
  resolveProjectSkillsDir: (p: { id: string }) => path.join(state.root, 'project-skills', p.id),
}));
vi.mock('./global-skills-dir.js', () => ({
  resolveGlobalSkillsDir: () => path.join(state.root, 'global-skills'),
}));
vi.mock('./auth.js', () => ({ isLocalBundledServer: () => false }));
vi.mock('./daily-summary-schedule.js', () => ({
  buildDailySummaryCaller: (userId: string) => ({ userId, role: 'User' }),
}));
vi.mock('./user-preferences-store.js', () => ({
  getUserPreferencesRow: () => state.prefs,
}));
vi.mock('./db.js', () => ({
  getStmts: () => ({ getAgentSkillOverrides: { all: () => [] } }),
}));

const {
  listServerAgentSkillOptions,
  resolveServerAgentSkillScope,
  serverAgentSkillScopeForUser,
  skillSchemaDirs,
  validateServerAgentSkillRefs,
  widenAllowedSkills,
} = await import('./server-agent-skills.js');
const { listEnabledSkills } = await import('./agent-skills-list.js');
const { loadSkillBody } = await import('./skill-invoke.js');

function writeSkill(dir: string, id: string, description = `${id} skill`): void {
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(
    path.join(dir, id, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id} body\n`,
  );
}

const shared = { id: 'alpha', name: 'Alpha', cwd: '/tmp', agents: [] } as unknown as Project;
const secret = {
  id: 'secret',
  name: 'Secret',
  cwd: '/tmp',
  agents: [],
  visibility: 'private',
  ownerUserId: 'someone-else',
} as unknown as Project;
const hub = {
  id: '__hub__',
  name: 'Hub',
  cwd: '/tmp',
  agents: [],
  kind: 'system',
} as unknown as Project;

const caller = { userId: 'u1', role: 'User' as const };

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'server-agent-skills-'));
  state.projects = [shared, secret, hub];
  state.prefs = {};
  writeSkill(path.join(state.root, 'global-skills'), 'shared-helper');
  writeSkill(path.join(state.root, 'project-skills', 'alpha'), 'alpha-deploy');
  writeSkill(path.join(state.root, 'project-skills', 'secret'), 'secret-tool');
  writeSkill(path.join(state.root, 'project-skills', '__hub__'), 'hub-only');
});

describe('listServerAgentSkillOptions', () => {
  it('offers global and bundled skills plus skills from visible projects only', () => {
    const options = listServerAgentSkillOptions(caller);
    const globalIds = options.global.map((s) => s.id);
    expect(globalIds).toContain('shared-helper');
    expect(globalIds).toContain('github');
    expect(globalIds).not.toContain('agent-hub');
    expect(options.builtIn).toContain('agent-hub');
    expect(options.projects).toEqual([
      expect.objectContaining({
        projectId: 'alpha',
        projectName: 'Alpha',
        skills: [expect.objectContaining({ id: 'alpha-deploy', source: 'project' })],
      }),
    ]);
  });
});

describe('validateServerAgentSkillRefs', () => {
  it('accepts global and visible project skills', () => {
    expect(
      validateServerAgentSkillRefs(
        [{ id: 'github' }, { id: 'alpha-deploy', projectId: 'alpha' }],
        caller,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects hidden projects, system projects, unknown and built-in skills, duplicate ids', () => {
    const bad = [
      [{ id: 'secret-tool', projectId: 'secret' }],
      [{ id: 'hub-only', projectId: '__hub__' }],
      [{ id: 'nope' }],
      [{ id: 'alpha-deploy' }],
      [{ id: 'agent-hub' }],
      [{ id: 'github' }, { id: 'github', projectId: 'alpha' }],
    ];
    for (const refs of bad) {
      expect(validateServerAgentSkillRefs(refs, caller).ok).toBe(false);
    }
  });

  it('keeps already-saved refs that stopped resolving, but not new ones', () => {
    const stale = [{ id: 'secret-tool', projectId: 'secret' }, { id: 'deleted-skill' }];
    expect(validateServerAgentSkillRefs(stale, caller, stale)).toEqual({ ok: true });
    expect(validateServerAgentSkillRefs([stale[0]!, { id: 'github' }], caller, stale).ok).toBe(
      true,
    );
    expect(validateServerAgentSkillRefs(stale, caller, [stale[1]!]).ok).toBe(false);
    expect(
      validateServerAgentSkillRefs(
        [stale[1]!, { id: 'deleted-skill', projectId: 'alpha' }],
        caller,
        stale,
      ).ok,
    ).toBe(false);
  });

  it('lets the private project owner add its skills', () => {
    expect(
      validateServerAgentSkillRefs([{ id: 'secret-tool', projectId: 'secret' }], {
        userId: 'someone-else',
      }).ok,
    ).toBe(true);
  });
});

describe('resolveServerAgentSkillScope', () => {
  it('pins project skills to their own store and drops refs that stopped resolving', () => {
    const scope = resolveServerAgentSkillScope(
      [
        { id: 'github' },
        { id: 'alpha-deploy', projectId: 'alpha' },
        { id: 'secret-tool', projectId: 'secret' },
        { id: 'deleted-skill' },
      ],
      caller,
    );
    expect(scope.ids).toEqual(['github', 'alpha-deploy']);
    expect(scope.pinned).toEqual([
      { id: 'alpha-deploy', root: path.join(state.root, 'project-skills', 'alpha') },
    ]);
  });

  it('reads the session owner preferences', () => {
    state.prefs = { serverAgent: { skills: [{ id: 'alpha-deploy', projectId: 'alpha' }] } };
    expect(serverAgentSkillScopeForUser('u1').ids).toEqual(['alpha-deploy']);
    expect(serverAgentSkillScopeForUser(null).ids).toEqual([]);
  });

  it('makes pinned skills listable and loadable from a different project session', () => {
    const scope = resolveServerAgentSkillScope(
      [{ id: 'alpha-deploy', projectId: 'alpha' }, { id: 'github' }],
      caller,
    );
    const hubSkillsDir = path.join(state.root, 'project-skills', '__hub__');
    const allowed = widenAllowedSkills(['agent-hub'], scope);
    expect(allowed).toEqual(['agent-hub', 'alpha-deploy', 'github']);

    const listed = listEnabledSkills('agent', hubSkillsDir, allowed, scope.pinned).map((s) => s.id);
    expect(listed.sort()).toEqual(['agent-hub', 'alpha-deploy', 'github']);

    const loaded = loadSkillBody('alpha-deploy', {
      skillsDir: hubSkillsDir,
      pinnedSkills: scope.pinned,
    });
    expect(loaded?.source).toBe('project');
    expect(loaded?.skillMd).toContain('alpha-deploy body');
    // Without the pin the other project's skill is unreachable.
    expect(loadSkillBody('alpha-deploy', { skillsDir: hubSkillsDir })).toBeNull();
  });
});

describe('helpers', () => {
  it('keeps unrestricted agents unrestricted', () => {
    expect(widenAllowedSkills(null, { ids: ['x'], pinned: [] })).toBeNull();
    expect(widenAllowedSkills(['a'], null)).toEqual(['a']);
  });

  it('adds a pinned root only for its own skill when reading schemas', () => {
    const scope = { ids: ['s'], pinned: [{ id: 's', root: '/p' }] };
    expect(skillSchemaDirs('/own', scope, 's')).toEqual(['/own', '/p']);
    expect(skillSchemaDirs('/own', scope, 'other')).toEqual(['/own']);
  });
});
