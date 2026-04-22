import { describe, it, expect } from 'vitest';
import { routeSkillFromMessage } from './skill-router.js';

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

  it('returns null when a manual <agenthub:skill> block is already present', () => {
    const result = routeSkillFromMessage({
      message: '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
      skills: ALL_SKILLS,
    });
    expect(result).toBeNull();
  });
});
