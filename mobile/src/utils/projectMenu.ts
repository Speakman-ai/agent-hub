/**
 * Per-project sidebar menu, grouped into labeled sections.
 *
 * Mirrors the web sidebar (`client/src/components/Sidebar.tsx`), which renders
 * the per-project navigation as five collapsible groups:
 *   - Git       — Repository, Pulls, Deployments
 *   - Planning  — Board, Epics, Notes
 *   - Support   — Customer Issues, Threads, Logs, RUM, Replays, AWS, Security
 *   - AI        — Agents, Wiki
 *   - Settings  — Project Configuration, Runners, Dev Server, Cron Jobs
 *
 * Mobile-specific divergences from web (intentional, no mobile surface exists):
 *   - Previews, Reviewer, and per-project Skills are web-only and omitted here.
 *   - `icon` values are Lucide icon names (rendered via `HubIcon`).
 */
import { isWorkflowProject } from './project-mode';

/**
 * Destinations hidden for workflow projects (dev/deploy surfaces that a
 * workflow-only project has no use for). Mirrors the `!workflowProject` gates in
 * the web sidebar. `repo` is intentionally NOT excluded — a workflow project can
 * still be Agent Hub-hosted.
 */
const WORKFLOW_EXCLUDED_KEYS = new Set([
    'pulls',
    'deployments',
    'epics',
    'stats',
    'support',
    'security',
    'replays',
    'logs',
    'rum',
    'runners',
    'dev-server',
]);

/**
 * @typedef {{ key: string, label: string, icon: string, screen: string, gate?: string }} MenuEntry
 * @typedef {{ key: string, label: string, entries: MenuEntry[] }} MenuGroup
 */

/**
 * The five labeled nav groups for a project, with per-item visibility applied
 * and empty groups removed.
 *
 * @param {{ githubRepo?: string, gitHost?: string, mode?: string, awsEnabled?: boolean }|null|undefined} project
 * @returns {MenuGroup[]}
 */
export function projectNavGroups(project: any) {
    const workflow = isWorkflowProject(project);
    const hasRepo = project?.gitHost === 'agenthub';
    const hasPulls = project?.githubRepo || project?.gitHost === 'agenthub';

    const groups = [
        {
            key: 'git',
            label: 'Git',
            entries: [
                hasRepo && {
                    key: 'repo',
                    label: 'Repository',
                    icon: 'GitBranch',
                    screen: 'Repository',
                },
                hasPulls && { key: 'pulls', label: 'Pulls', icon: 'ListOrdered', screen: 'PullRequests' },
                { key: 'deployments', label: 'Deployments', icon: 'Cloud', screen: 'Deployments' },
            ],
        },
        {
            key: 'planning',
            label: 'Planning',
            entries: [
                { key: 'board', label: 'Board', icon: 'LayoutGrid', screen: 'Kanban' },
                { key: 'card-templates', label: 'Card Templates', icon: 'FileSpreadsheet', screen: 'KanbanCardTemplates' },
                { key: 'epics', label: 'Epics', icon: 'Target', screen: 'Epics' },
                { key: 'stats', label: 'Stats', icon: 'BarChart3', screen: 'Stats' },
                { key: 'notes', label: 'Notes', icon: 'StickyNote', screen: 'Notes' },
            ],
        },
        {
            key: 'support',
            label: 'Support',
            entries: [
                { key: 'support', label: 'Customer Issues', icon: 'LifeBuoy', screen: 'CustomerSupport' },
                { key: 'threads', label: 'Threads', icon: 'List', screen: 'Threads' },
                { key: 'logs', label: 'Logs', icon: 'ScrollText', screen: 'Logs' },
                { key: 'rum', label: 'RUM', icon: 'Activity', screen: 'RumSettings' },
                { key: 'replays', label: 'Replays', icon: 'MonitorPlay', screen: 'Replays' },
                project?.awsEnabled && { key: 'aws', label: 'AWS', icon: 'Cloud', screen: 'AwsProfiles' },
                { key: 'security', label: 'Security', icon: 'ShieldAlert', screen: 'Security' },
            ],
        },
        {
            key: 'ai',
            label: 'AI',
            entries: [
                { key: 'project-agents', label: 'Agents', icon: 'Bot', screen: 'ProjectAgents' },
                { key: 'wiki', label: 'Wiki', icon: 'BookOpen', screen: 'Wiki' },
            ],
        },
        {
            key: 'settings',
            label: 'Settings',
            entries: [
                {
                    key: 'project-settings',
                    label: 'Project Configuration',
                    icon: 'Settings',
                    screen: 'ProjectSettings',
                },
                { key: 'runners', label: 'Runners', icon: 'Play', screen: 'Runners' },
                { key: 'dev-server', label: 'Dev Server', icon: 'Terminal', screen: 'DevServer' },
                { key: 'project-crons', label: 'Cron Jobs', icon: 'Clock', screen: 'ProjectCrons' },
            ],
        },
    ];

    return groups
        .map((group) => ({
            ...group,
            entries: group.entries
                .filter(Boolean)
                .filter((entry: any) => !(workflow && WORKFLOW_EXCLUDED_KEYS.has(entry.key))),
        }))
        .filter((group) => group.entries.length > 0);
}
