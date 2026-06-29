// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { projectLifecycleEntries, projectSettingsEntries, projectMenuEntries, } from './projectMenu';
import { isHubIconName } from './hubIconNames';
describe('projectLifecycleEntries', () => {
    it('includes core lifecycle destinations', () => {
        const keys = projectLifecycleEntries({}).map((e: any) => e.key);
        expect(keys).toContain('board');
        expect(keys).toContain('epics');
        expect(keys).toContain('deployments');
        expect(keys).toContain('threads');
        expect(keys).toContain('support');
        expect(keys).toContain('security');
        expect(keys).toContain('wiki');
        expect(keys).toContain('notes');
        expect(keys).not.toContain('workflows');
    });
    it('exposes Deployments as a lifecycle destination', () => {
        const entry = projectLifecycleEntries({}).find((e: any) => e.key === 'deployments');
        expect(entry).toMatchObject({
            label: 'Deployments',
            icon: 'Cloud',
            screen: 'Deployments',
        });
    });
    it('adds Repository when gitHost is agenthub', () => {
        const keys = projectLifecycleEntries({ gitHost: 'agenthub' }).map((e: any) => e.key);
        expect(keys[0]).toBe('repo');
    });
    it('adds Pulls when the project has a GitHub repo and is not a workflow', () => {
        const keys = projectLifecycleEntries({ githubRepo: 'owner/repo' }).map((e: any) => e.key);
        expect(keys).toContain('pulls');
    });
    it('adds Pulls for Agent Hub-hosted projects', () => {
        const keys = projectLifecycleEntries({ gitHost: 'agenthub' }).map((e: any) => e.key);
        expect(keys).toContain('pulls');
    });
    it('omits Pulls for workflow projects even with a repo', () => {
        const keys = projectLifecycleEntries({ githubRepo: 'owner/repo', mode: 'workflow' }).map((e: any) => e.key);
        expect(keys).not.toContain('pulls');
    });
    it('omits dev-only lifecycle destinations for workflow projects', () => {
        const keys = projectLifecycleEntries({ mode: 'workflow' }).map((e: any) => e.key);
        expect(keys).not.toContain('deployments');
        expect(keys).not.toContain('support');
        expect(keys).not.toContain('security');
        expect(keys).toContain('board');
        expect(keys).toContain('wiki');
    });
    it('does not include preview surfaces', () => {
        const all = [
            ...projectLifecycleEntries({ gitHost: 'agenthub', githubRepo: 'x/y' }),
            ...projectSettingsEntries({ awsEnabled: true }),
        ].map((e: any) => e.key);
        expect(all).not.toContain('preview');
    });
    it('uses registered Lucide icon names for every entry', () => {
        const entries = [
            ...projectLifecycleEntries({ gitHost: 'agenthub', githubRepo: 'x/y' }),
            ...projectSettingsEntries({ awsEnabled: true }),
        ];
        for (const entry of entries) {
            expect(isHubIconName(entry.icon), `${entry.key} → ${entry.icon}`).toBe(true);
        }
    });
});
describe('projectSettingsEntries', () => {
    it('includes project configuration and runners', () => {
        const keys = projectSettingsEntries({}).map((e: any) => e.key);
        expect(keys).toContain('project-settings');
        expect(keys).toContain('project-agents');
        expect(keys).toContain('runners');
        expect(keys).toContain('rum');
        expect(keys).toContain('project-crons');
    });
    it('exposes project Secrets so they are reachable on mobile', () => {
        // Regression: the global Secrets tab was removed; project secrets must be
        // reachable via the per-project Settings submenu (→ ProjectSecrets screen).
        const entry = projectSettingsEntries({}).find((e: any) => e.key === 'project-secrets');
        expect(entry).toBeTruthy();
        expect(entry.screen).toBe('ProjectSecrets');
        expect(entry.label).toBe('Secrets');
    });
    it('adds AWS when enabled', () => {
        const keys = projectSettingsEntries({ awsEnabled: true }).map((e: any) => e.key);
        expect(keys).toContain('aws');
    });
    it('omits Reviewer from project settings menu', () => {
        const keys = projectSettingsEntries({}).map((e: any) => e.key);
        expect(keys).not.toContain('reviewer');
    });
    it('omits runners and RUM for workflow projects', () => {
        const keys = projectSettingsEntries({ mode: 'workflow' }).map((e: any) => e.key);
        expect(keys).not.toContain('runners');
        expect(keys).not.toContain('rum');
        expect(keys).toContain('project-settings');
        expect(keys).toContain('project-crons');
    });
});
describe('projectMenuEntries (legacy alias)', () => {
    it('delegates to projectLifecycleEntries', () => {
        expect(projectMenuEntries({}).map((e: any) => e.key)).toEqual(projectLifecycleEntries({}).map((e: any) => e.key));
    });
});
