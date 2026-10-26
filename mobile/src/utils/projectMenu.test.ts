// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { projectNavGroups } from './projectMenu';
import { isHubIconName } from './hubIconNames';

const flat = (project) => projectNavGroups(project).flatMap((g) => g.entries);
const keys = (project) => flat(project).map((e) => e.key);
const groupKeys = (project) => projectNavGroups(project).map((g) => g.key);
const group = (project, key) => projectNavGroups(project).find((g) => g.key === key);

describe('projectNavGroups', () => {
  it('exposes the five labeled groups in order for a standard hosted project', () => {
    expect(groupKeys({ gitHost: 'agenthub' })).toEqual([
      'git',
      'planning',
      'support',
      'ai',
      'settings',
    ]);
  });

  it('places core destinations in the expected groups', () => {
    expect(group({}, 'planning').entries.map((e) => e.key)).toEqual([
      'board',
      'epics',
      'qa',
      'stats',
      'notes',
    ]);
    expect(group({}, 'support').entries.map((e) => e.key)).toEqual([
      'support',
      'logs',
      'rum',
      'replays',
      'security',
    ]);
    expect(group({}, 'ai').entries.map((e) => e.key)).toEqual([
      'project-agents',
      'background-agents',
      'skills',
      'wiki',
    ]);
    expect(group({}, 'settings').entries.map((e) => e.key)).toEqual([
      'project-settings',
      'runners',
      'dev-server',
      'project-crons',
    ]);
  });

  it('labels the customer-support entry "Customer Issues" (→ CustomerSupport screen)', () => {
    const entry = flat({}).find((e) => e.key === 'support');
    expect(entry).toMatchObject({ label: 'Customer Issues', screen: 'CustomerSupport' });
  });

  it('has no Threads entry', () => {
    expect(flat({}).map((e) => e.key)).not.toContain('threads');
  });

  it('groups Wiki, Agents, Background Agents, and Skills under AI', () => {
    expect(group({}, 'ai').entries.map((e) => e.key)).toEqual([
      'project-agents',
      'background-agents',
      'skills',
      'wiki',
    ]);
  });

  it('no longer exposes a Secrets entry (removed from the nav)', () => {
    expect(keys({})).not.toContain('project-secrets');
  });

  it('includes Reviewer, Skills, and Background Agents when the web sidebar does', () => {
    const all = keys({
      gitHost: 'agenthub',
      githubRepo: 'x/y',
      awsEnabled: true,
      agents: [{ role: 'reviewer' }],
    });
    expect(all).toContain('skills');
    expect(all).toContain('background-agents');
    expect(all).toContain('reviewer');
    expect(group({ agents: [{ role: 'reviewer' }] }, 'ai').entries[0].key).toBe('reviewer');
  });

  it('hides Reviewer when the project has no reviewer agent', () => {
    expect(keys({ agents: [{ role: 'lead' }] })).not.toContain('reviewer');
  });

  it('omits Calendar (a global Google surface, not project-scoped)', () => {
    expect(keys({})).not.toContain('calendar');
  });

  it('adds Repository first in the Git group when gitHost is agenthub', () => {
    expect(group({ gitHost: 'agenthub' }, 'git').entries[0].key).toBe('repo');
  });

  it('adds Pulls when the project has a GitHub repo', () => {
    expect(keys({ githubRepo: 'owner/repo' })).toContain('pulls');
  });

  it('omits Pulls for workflow projects even with a repo', () => {
    expect(keys({ githubRepo: 'owner/repo', mode: 'workflow' })).not.toContain('pulls');
  });

  it('adds AWS to the Support group when enabled', () => {
    expect(group({ awsEnabled: true }, 'support').entries.map((e) => e.key)).toContain('aws');
  });

  it('adds Infrastructure to the Support group when infraEnabled', () => {
    const entries = group({ infraEnabled: true }, 'support').entries;
    expect(entries.map((e: any) => e.key)).toContain('infra');
    expect(entries.find((e: any) => e.key === 'infra')).toMatchObject({
      label: 'Infrastructure',
      screen: 'Infrastructure',
    });
  });

  it('hides Infrastructure when the project flag is off', () => {
    // Mirrors the web sidebar gate (`project.infraEnabled`); an ungated entry
    // would navigate to a module the project has not turned on.
    expect(keys({})).not.toContain('infra');
    expect(keys({ infraEnabled: false })).not.toContain('infra');
  });

  it('places Infrastructure directly after AWS, as the web sidebar does', () => {
    const keysInGroup = group({ awsEnabled: true, infraEnabled: true }, 'support').entries.map(
      (e: any) => e.key,
    );
    expect(keysInGroup.indexOf('infra')).toBe(keysInGroup.indexOf('aws') + 1);
  });

  it('drops the Git group entirely for a workflow project without Agent Hub hosting', () => {
    expect(groupKeys({ mode: 'workflow' })).not.toContain('git');
  });

  it('omits dev-only destinations for workflow projects but keeps the rest', () => {
    const k = keys({ mode: 'workflow' });
    for (const excluded of [
      'deployments',
      'pulls',
      'stats',
      'support',
      'security',
      'replays',
      'logs',
      'rum',
      'runners',
      'dev-server',
    ]) {
      expect(k, `expected workflow project to omit ${excluded}`).not.toContain(excluded);
    }
    for (const kept of [
      'board',
      'epics',
      'notes',
      'wiki',
      'skills',
      'background-agents',
      'project-agents',
      'project-settings',
      'project-crons',
    ]) {
      expect(k, `expected workflow project to keep ${kept}`).toContain(kept);
    }
    expect(k).not.toContain('workflows');
    expect(k).not.toContain('card-templates');
  });

  it('keeps an empty Support header on a workflow project, matching web', () => {
    expect(group({ mode: 'workflow' }, 'support').entries).toEqual([]);
  });

  it('uses registered Lucide icon names for every entry', () => {
    const entries = flat({ gitHost: 'agenthub', githubRepo: 'x/y', awsEnabled: true });
    for (const entry of entries) {
      expect(isHubIconName(entry.icon), `${entry.key} → ${entry.icon}`).toBe(true);
    }
  });
});
