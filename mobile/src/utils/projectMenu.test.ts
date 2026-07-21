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
            'card-templates',
            'workflows',
            'epics',
            'stats',
            'notes',
        ]);
        expect(group({}, 'support').entries.map((e) => e.key)).toEqual(
            expect.arrayContaining(['support', 'threads', 'logs', 'rum', 'replays', 'security']),
        );
        expect(group({}, 'ai').entries.map((e) => e.key)).toEqual(['project-agents', 'wiki']);
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

    it('groups Threads under Support', () => {
        expect(group({}, 'support').entries.map((e) => e.key)).toContain('threads');
    });

    it('groups Wiki and Agents under AI', () => {
        expect(group({}, 'ai').entries.map((e) => e.key)).toEqual(['project-agents', 'wiki']);
    });

    it('no longer exposes a Secrets entry (removed from the nav)', () => {
        expect(keys({})).not.toContain('project-secrets');
    });

    it('omits web-only surfaces (preview, per-project skills, reviewer)', () => {
        const all = keys({
            gitHost: 'agenthub',
            githubRepo: 'x/y',
            awsEnabled: true,
            agents: [{ role: 'reviewer' }],
        });
        expect(all).not.toContain('preview');
        expect(all).not.toContain('skills');
        expect(all).not.toContain('reviewer');
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

    it('drops the Git group entirely for a workflow project without Agent Hub hosting', () => {
        expect(groupKeys({ mode: 'workflow' })).not.toContain('git');
    });

    it('omits dev-only destinations for workflow projects but keeps the rest', () => {
        const k = keys({ mode: 'workflow' });
        for (const excluded of [
            'deployments',
            'pulls',
            'epics',
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
            'workflows',
            'notes',
            'threads',
            'wiki',
            'project-agents',
            'project-settings',
            'project-crons',
        ]) {
            expect(k, `expected workflow project to keep ${kept}`).toContain(kept);
        }
    });

    it('uses registered Lucide icon names for every entry', () => {
        const entries = flat({ gitHost: 'agenthub', githubRepo: 'x/y', awsEnabled: true });
        for (const entry of entries) {
            expect(isHubIconName(entry.icon), `${entry.key} → ${entry.icon}`).toBe(true);
        }
    });
});
