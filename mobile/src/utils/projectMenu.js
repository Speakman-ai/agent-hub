/**
 * Per-project sidebar menu entries.
 *
 * Mirrors the web sidebar's collapsible "<project> Settings" menu
 * (`client/src/components/Sidebar.jsx`), limited to the project-scoped
 * destinations the mobile app actually has screens for. Each entry maps to a
 * React Navigation screen name. Pure + data-only so it can be unit-tested
 * without rendering the drawer.
 */

import { isWorkflowProject } from './project-mode';

/**
 * Build the ordered list of menu entries for a project.
 *
 * - `Pulls` is only shown when the project has a GitHub repo and is not a
 *   workflow project (matches the web sidebar's `project.mode !== 'workflow'`
 *   + repo gate, and the existing mobile inline-button condition).
 *
 * @param {{ githubRepo?: string, mode?: string }|null|undefined} project
 * @returns {Array<{ key: string, label: string, icon: string, screen: string }>}
 */
export function projectMenuEntries(project) {
  const entries = [
    { key: 'board', label: 'Board', icon: '▦', screen: 'Kanban' },
    { key: 'threads', label: 'Threads', icon: '☰', screen: 'Threads' },
    { key: 'support', label: 'Support', icon: '⛑', screen: 'CustomerSupport' },
  ];

  if (project?.githubRepo && !isWorkflowProject(project)) {
    entries.push({ key: 'pulls', label: 'Pulls', icon: '⎇', screen: 'PullRequests' });
  }

  entries.push({ key: 'wiki', label: 'Wiki', icon: '\u{1F4D6}', screen: 'Wiki' });
  entries.push({ key: 'notes', label: 'Notes', icon: '\u{1F4DD}', screen: 'Notes' });

  return entries;
}
