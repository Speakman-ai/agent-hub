/**
 * Per-project sidebar menu, grouped into labeled sections.
 *
 * Mirrors the web sidebar (`client/src/components/Sidebar.tsx`):
 *   - Git       — Repository, Pulls, Deployments
 *   - Planning  — Board, Epics, Stats, Notes
 *   - Support   — Customer Issues, Logs, RUM, Replays, AWS, Infrastructure, Security
 *   - AI        — Reviewer, Agents, Background Agents, Skills, Wiki
 *   - Settings  — Project Configuration, Finalize CI, Previews, Cron Jobs
 *
 * Git is omitted when it has no items. Support stays even when a workflow
 * project has nothing under it, matching the web group header.
 */
import { isWorkflowProject } from './project-mode';

/**
 * @typedef {{ key: string, label: string, icon: string, screen: string }} MenuEntry
 * @typedef {{ key: string, label: string, entries: MenuEntry[] }} MenuGroup
 */

/**
 * The labeled nav groups for a project, with per-item visibility applied.
 *
 * `agents` is the project's agent list when the caller has it flat (the mobile
 * drawer). Falls back to `project.agents`, which is what the web sidebar reads.
 *
 * @param {{ githubRepo?: string, gitHost?: string, mode?: string, awsEnabled?: boolean, infraEnabled?: boolean, agents?: Array<{ role?: string }> }|null|undefined} project
 * @param {Array<{ role?: string }>|undefined} [agents]
 */
export function projectNavGroups(project: any, agents?: any[]) {
  const workflow = isWorkflowProject(project);
  const hasRepo = project?.gitHost === 'agenthub';
  const hasPulls = (!!project?.githubRepo || project?.gitHost === 'agenthub') && !workflow;
  const agentList = Array.isArray(agents) ? agents : project?.agents || [];
  const hasReviewer = agentList.some((agent: any) => agent?.role === 'reviewer');

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
        !workflow && {
          key: 'deployments',
          label: 'Deployments',
          icon: 'Cloud',
          screen: 'Deployments',
        },
      ],
    },
    {
      key: 'planning',
      label: 'Planning',
      entries: [
        { key: 'board', label: 'Board', icon: 'LayoutGrid', screen: 'Kanban' },
        { key: 'epics', label: 'Epics', icon: 'Target', screen: 'Epics' },
        !workflow && { key: 'stats', label: 'Stats', icon: 'BarChart3', screen: 'Stats' },
        { key: 'notes', label: 'Notes', icon: 'StickyNote', screen: 'Notes' },
      ],
    },
    {
      key: 'support',
      label: 'Support',
      entries: [
        !workflow && {
          key: 'support',
          label: 'Customer Issues',
          icon: 'LifeBuoy',
          screen: 'CustomerSupport',
        },
        !workflow && { key: 'logs', label: 'Logs', icon: 'ScrollText', screen: 'Logs' },
        !workflow && { key: 'rum', label: 'RUM', icon: 'Activity', screen: 'RumSettings' },
        !workflow && { key: 'replays', label: 'Replays', icon: 'MonitorPlay', screen: 'Replays' },
        project?.awsEnabled && { key: 'aws', label: 'AWS', icon: 'Cloud', screen: 'AwsProfiles' },
        project?.infraEnabled && {
          key: 'infra',
          label: 'Infrastructure',
          icon: 'Server',
          screen: 'Infrastructure',
        },
        !workflow && {
          key: 'security',
          label: 'Security',
          icon: 'ShieldAlert',
          screen: 'Security',
        },
      ],
    },
    {
      key: 'ai',
      label: 'AI',
      entries: [
        hasReviewer && { key: 'reviewer', label: 'Reviewer', icon: 'ScanEye', screen: 'Reviewer' },
        { key: 'project-agents', label: 'Agents', icon: 'Bot', screen: 'ProjectAgents' },
        {
          key: 'background-agents',
          label: 'Background Agents',
          icon: 'Sparkles',
          screen: 'BackgroundAgents',
        },
        { key: 'skills', label: 'Skills', icon: 'Puzzle', screen: 'Skills' },
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
        !workflow && { key: 'runners', label: 'Finalize CI', icon: 'Play', screen: 'Runners' },
        !workflow && {
          key: 'dev-server',
          label: 'Previews',
          icon: 'Terminal',
          screen: 'DevServer',
        },
        { key: 'project-crons', label: 'Cron Jobs', icon: 'Clock', screen: 'ProjectCrons' },
      ],
    },
  ];

  return groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter(Boolean),
    }))
    .filter((group) => group.key === 'support' || group.entries.length > 0);
}
