import { describe, it, expect } from 'vitest';
import { routeSkillFromMessage, routeSkillsFromMessage } from './skill-router.js';

const ALL_SKILLS = [
  { id: 'kanban', name: 'kanban', description: 'Manage board cards' },
  { id: 'wiki-search', name: 'wiki-search', description: 'Search project wiki' },
  { id: 'using-git-worktrees', name: 'using-git-worktrees', description: 'Create worktrees' },
  { id: 'design', name: 'design', description: 'Design Studio authoring' },
  { id: 'designs', name: 'designs', description: 'Read design artifacts' },
  { id: 'agent-hub', name: 'agent-hub', description: 'Agent Hub platform' },
  { id: 'clawhub-sync', name: 'ClawHub Sync', description: 'Custom installed skill' },
];

describe('routeSkillFromMessage', () => {
  it('routes kanban intent from board/card vocabulary', () => {
    const result = routeSkillFromMessage({
      message: 'Please move this card on the board and update the backlog.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).toBe('kanban');
  });

  it('does not false-positive kanban for third-party tools', () => {
    const result = routeSkillFromMessage({
      message: 'Create this in Linear kanban board and sync to Jira.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).not.toBe('kanban');
  });

  it('routes wiki-search for docs/architecture requests', () => {
    const result = routeSkillFromMessage({
      message: 'Search wiki for architecture docs before implementing.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).toBe('wiki-search');
  });

  it('routes using-git-worktrees for isolation request', () => {
    const result = routeSkillFromMessage({
      message: 'Start this on a feature branch in an isolated worktree.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).toBe('using-git-worktrees');
  });

  it('routes designs for mockup/prototype requests in normal sessions', () => {
    const result = routeSkillFromMessage({
      message: 'Find the prototype design and reference the landing page mockup.',
      skills: ALL_SKILLS,
      agentId: 'hub-frontend',
      cwd: '/repo',
    });
    expect(result?.skillId).toBe('designs');
  });

  it('does not route designs for generic design-system discussion', () => {
    const result = routeSkillFromMessage({
      message: 'Follow our design system spacing scale for this React page.',
      skills: ALL_SKILLS,
      agentId: 'hub-frontend',
      cwd: '/repo',
    });
    expect(result).toBeNull();
  });

  it('routes design only in Design Studio sessions', () => {
    const result = routeSkillFromMessage({
      message: 'Build a polished hero section',
      skills: ALL_SKILLS,
      agentId: '__design_studio__',
      cwd: '/tmp/designs/abc123',
      agentSystemPrompt: 'You are Design Studio',
    });
    expect(result?.skillId).toBe('design');
  });

  it('routes Agent Hub platform requests', () => {
    const result = routeSkillFromMessage({
      message: 'Use http://localhost:3051/api/projects/agent-hub/board to inspect state.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).toBe('agent-hub');
  });

  it('routes explicit skill mention for new installed skills', () => {
    const result = routeSkillFromMessage({
      message: 'Use clawhub-sync skill for this import.',
      skills: ALL_SKILLS,
    });
    expect(result?.skillId).toBe('clawhub-sync');
    expect(result?.reason).toContain('explicit');
  });

  it('routes bare whole-word mention for short skill ids like linear', () => {
    const SKILLS_WITH_LINEAR = [
      ...ALL_SKILLS,
      { id: 'linear', name: 'Linear', description: 'Linear MCP workflows' },
    ];
    const result = routeSkillFromMessage({
      message: 'Open my Linear issues for the current cycle.',
      skills: SKILLS_WITH_LINEAR,
    });
    expect(result?.skillId).toBe('linear');
    expect(result?.reason).toContain('explicit');
  });

  it('returns null when a manual <agenthub:skill> block is already present', () => {
    const result = routeSkillFromMessage({
      message: '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
      skills: ALL_SKILLS,
    });
    expect(result).toBeNull();
  });
});

describe('routeSkillsFromMessage — multi-match + project default', () => {
  const SKILLS = [
    { id: 'agent-hub', name: 'Agent Hub' },
    { id: 'kanban', name: 'Kanban' },
    { id: 'wiki-search', name: 'Wiki Search' },
  ];

  it('(a) injects agent-hub via project-default rule when no platform tell is present', () => {
    const matches = routeSkillsFromMessage({
      message: 'fix this bug',
      skills: SKILLS,
      projectSlug: 'agent-hub',
    });
    const ahMatch = matches.find((m) => m.skillId === 'agent-hub');
    expect(ahMatch).toBeDefined();
    expect(ahMatch?.reason).toContain('project default');
  });

  it('(b) does not inject agent-hub for non-agent-hub projects with no platform tell', () => {
    const matches = routeSkillsFromMessage({
      message: 'fix this bug',
      skills: SKILLS,
      projectSlug: 'other-project',
    });
    expect(matches.find((m) => m.skillId === 'agent-hub')).toBeUndefined();
  });

  it('(c) returns kanban first by score when both kanban and agent-hub default match', () => {
    const matches = routeSkillsFromMessage({
      message: 'create a kanban card',
      skills: SKILLS,
      projectSlug: 'agent-hub',
    });
    const ids = matches.map((m) => m.skillId);
    expect(ids).toContain('kanban');
    expect(ids).toContain('agent-hub');
    expect(ids[0]).toBe('kanban');
    const ahMatch = matches.find((m) => m.skillId === 'agent-hub')!;
    expect(ahMatch.reason).toContain('project default');
  });

  it('(d) explicit-trigger match for agent-hub wins over project-default (de-dupe keeps higher score)', () => {
    const matches = routeSkillsFromMessage({
      message: 'spawn helpers via <delegate>{"toAgent":"x"}</delegate>',
      skills: SKILLS,
      projectSlug: 'agent-hub',
    });
    const ahMatch = matches.find((m) => m.skillId === 'agent-hub');
    expect(ahMatch).toBeDefined();
    expect(ahMatch?.reason).not.toContain('project default');
    expect(ahMatch?.reason).toContain('Agent Hub platform intent');
    expect(ahMatch?.score).toBeGreaterThan(30);
    // De-duped: only one agent-hub entry.
    expect(matches.filter((m) => m.skillId === 'agent-hub')).toHaveLength(1);
  });

  it('(e) script-path tell triggers agent-hub even outside the agent-hub project', () => {
    const matches = routeSkillsFromMessage({
      message: 'run scripts/board.sh get to inspect the board',
      skills: SKILLS,
      projectSlug: 'random',
    });
    const ahMatch = matches.find((m) => m.skillId === 'agent-hub');
    expect(ahMatch).toBeDefined();
    expect(ahMatch?.reason).toContain('Agent Hub platform intent');
  });

  it('(f) routeSkillFromMessage shim still returns the highest match for legacy callers', () => {
    const result = routeSkillFromMessage({
      message: 'create a kanban card',
      skills: SKILLS,
      projectSlug: 'agent-hub',
    });
    expect(result?.skillId).toBe('kanban');
  });
});
