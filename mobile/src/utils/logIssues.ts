/**
 * Pure helpers for the mobile Issues view (LOG-GROUP lifecycle).
 *
 * Mirrors the state math embedded in `client/src/components/logs/IssuesView.tsx`
 * (status tabs, page merge, optimistic transition apply). Kept transport-free
 * and UI-free so the list/detail state transitions are unit-testable without a
 * React tree. All issue text is UNTRUSTED (LOG-TRUST) — callers render it as
 * <Text> only.
 */
import type { LogRecord } from './logStream';

export interface IssueRelease {
  release: string | null;
  commitSha: string | null;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
}

export type IssueStatus = 'open' | 'resolved' | 'ignored';

export interface LogIssue {
  id: string;
  projectId: string;
  fingerprint: string;
  title: string | null;
  service: string | null;
  environment: string | null;
  exceptionType: string | null;
  messageTemplate: string | null;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  status: IssueStatus;
  statusUpdatedAt: number | null;
  statusUpdatedBy: string | null;
  analyzeSessionId: string | null;
  fixCardId?: string | null;
  fixSessionId?: string | null;
  releases?: IssueRelease[];
  samples?: LogRecord[];
}

export type IssueAction = 'resolve' | 'ignore' | 'reopen';

/** Status filter tabs (empty key = All), matching the web order. */
export const STATUS_TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ignored', label: 'Ignored' },
  { key: '', label: 'All' },
];

/** Display label for an issue row header — never empty. */
export function issueDisplayTitle(issue: Pick<LogIssue, 'title' | 'messageTemplate'>): string {
  return issue.title || issue.messageTemplate || '(no message)';
}

/**
 * Merge a freshly-loaded issue page into the list: append for pagination, else
 * replace. Non-array inputs collapse to `[]` so a malformed response can never
 * throw or inject `undefined` rows.
 */
export function mergeIssuePage(
  previous: readonly LogIssue[] | unknown,
  rows: readonly LogIssue[] | unknown,
  append: boolean,
): LogIssue[] {
  const prev = Array.isArray(previous) ? (previous as LogIssue[]) : [];
  const next = Array.isArray(rows) ? (rows as LogIssue[]) : [];
  return append ? [...prev, ...next] : [...next];
}

/**
 * Apply a lifecycle transition result to a list in place of the matching issue.
 * Shallow-merges the server's updated fields onto the existing row so unrelated
 * columns (samples, releases already loaded) survive.
 */
export function applyIssueUpdate(
  issues: readonly LogIssue[],
  id: string,
  updated: Partial<LogIssue>,
): LogIssue[] {
  return issues.map((i) => (i.id === id ? { ...i, ...updated } : i));
}

/**
 * Reconcile the visible list after a lifecycle transition, honouring the active
 * status-tab filter. On a filtered tab (`open`/`resolved`/`ignored`) an issue
 * whose new status no longer matches the tab is removed — otherwise a resolved
 * issue would linger under the `Open` tab with a stale chip until reload. On the
 * `All` tab (`statusFilter === ''`) the row is updated in place and kept.
 */
export function applyTransitionToList(
  issues: readonly LogIssue[],
  id: string,
  updated: Partial<LogIssue>,
  statusFilter: string,
): LogIssue[] {
  if (statusFilter && updated.status && updated.status !== statusFilter) {
    return issues.filter((i) => i.id !== id);
  }
  return applyIssueUpdate(issues, id, updated);
}

/** True when a transition result should drop the row from the current tab. */
export function transitionRemovesFromTab(
  updated: Partial<LogIssue>,
  statusFilter: string,
): boolean {
  return Boolean(statusFilter) && Boolean(updated.status) && updated.status !== statusFilter;
}

/** Which lifecycle actions are offered for an issue in a given status. */
export function availableActions(status: IssueStatus): IssueAction[] {
  const actions: IssueAction[] = [];
  if (status !== 'resolved') actions.push('resolve');
  if (status !== 'ignored') actions.push('ignore');
  if (status !== 'open') actions.push('reopen');
  return actions;
}
