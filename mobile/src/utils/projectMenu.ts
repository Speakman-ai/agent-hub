/**
 * Per-project sidebar menu entries.
 *
 * Mirrors the web sidebar (`client/src/components/Sidebar.jsx`):
 *  - `lifecycleEntries` — always visible when the project is expanded
 *  - `settingsEntries` — collapsed under "<project> Settings"
 *
 * Previews are intentionally excluded (no mobile preview surfaces).
 * `icon` values are Lucide icon names (rendered via `HubIcon`).
 */
import { isWorkflowProject } from './project-mode';

const WORKFLOW_EXCLUDED_LIFECYCLE_KEYS = new Set([
    'deployments',
    'support',
    'security',
]);
const WORKFLOW_EXCLUDED_SETTINGS_KEYS = new Set(['runners', 'rum']);
/**
 * @typedef {{ key: string, label: string, icon: string, screen: string, gate?: string }} MenuEntry
 */
/**
 * Top-level lifecycle destinations (Board, Epics, Notes, etc.)
 *
 * @param {{ githubRepo?: string, gitHost?: string, mode?: string, awsEnabled?: boolean }|null|undefined} project
 * @returns {MenuEntry[]}
 */
export function projectLifecycleEntries(project: any) {
    const entries = [];
    if (project?.gitHost === 'agenthub') {
        entries.push({ key: 'repo', label: 'Repository', icon: 'GitBranch', screen: 'Repository' });
    }
    if ((project?.githubRepo || project?.gitHost === 'agenthub') && !isWorkflowProject(project)) {
        entries.push({ key: 'pulls', label: 'Pulls', icon: 'ListOrdered', screen: 'PullRequests' });
    }
    entries.push({ key: 'deployments', label: 'Deployments', icon: 'Cloud', screen: 'Deployments' }, { key: 'board', label: 'Board', icon: 'LayoutGrid', screen: 'Kanban' }, { key: 'epics', label: 'Epics', icon: 'Target', screen: 'Epics' }, { key: 'notes', label: 'Notes', icon: 'StickyNote', screen: 'Notes' }, { key: 'threads', label: 'Threads', icon: 'List', screen: 'Threads' }, { key: 'support', label: 'Support', icon: 'LifeBuoy', screen: 'CustomerSupport' }, { key: 'security', label: 'Security', icon: 'ShieldAlert', screen: 'Security' }, { key: 'wiki', label: 'Wiki', screen: 'Wiki', icon: 'BookOpen' });
    if (isWorkflowProject(project)) {
        return entries.filter((entry) => !WORKFLOW_EXCLUDED_LIFECYCLE_KEYS.has(entry.key));
    }
    return entries;
}
/**
 * Configuration submenu under "<project> Settings".
 *
 * @param {{ awsEnabled?: boolean }|null|undefined} project
 * @returns {MenuEntry[]}
 */
export function projectSettingsEntries(project: any) {
    const entries = [
        {
            key: 'project-settings',
            label: 'Project Configuration',
            icon: 'Settings',
            screen: 'ProjectSettings',
        },
        { key: 'project-secrets', label: 'Secrets', icon: 'KeyRound', screen: 'ProjectSecrets' },
        { key: 'project-agents', label: 'Agents', icon: 'Bot', screen: 'ProjectAgents' },
        { key: 'runners', label: 'Runners', icon: 'Play', screen: 'Runners' },
        { key: 'rum', label: 'RUM', icon: 'Activity', screen: 'RumSettings' },
    ];
    if (project?.awsEnabled) {
        entries.push({ key: 'aws', label: 'AWS', icon: 'Cloud', screen: 'AwsProfiles' });
    }
    entries.push({ key: 'project-crons', label: 'Cron Jobs', icon: 'Clock', screen: 'ProjectCrons' });
    if (isWorkflowProject(project)) {
        return entries.filter((entry) => !WORKFLOW_EXCLUDED_SETTINGS_KEYS.has(entry.key));
    }
    return entries;
}
/** @deprecated Use projectLifecycleEntries — kept for tests migrating gradually */
export function projectMenuEntries(project: any) {
    return projectLifecycleEntries(project);
}
