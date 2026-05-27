import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateBoard } from './routes/board.js';
import type { KanbanCardRow, KanbanColumnRow, KanbanEpicRow, Stmts } from './types.js';
import {
  LINEAR_REQUEST_TIMEOUT_MS,
  type LinearKanbanSyncProjectConfig,
} from './linear-kanban-sync-config.js';

const LINEAR_GQL_URL = 'https://api.linear.app/graphql';

const MCS_TITLE_RE = /^(MCS-\d+)\s*:/i;

export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string };
  project: { id: string; name: string } | null;
}

export interface LinearKanbanSyncCheckpoint {
  version: 1;
  projectId: string;
  phase: 'fetch' | 'sync';
  fetchCursor: string | null;
  fetchComplete: boolean;
  issues: LinearIssueSnapshot[];
  syncIndex: number;
  updatedAt: string;
}

export interface LinearKanbanSyncStats {
  issuesFetched: number;
  cardsCreated: number;
  cardsUpdated: number;
  descriptionsUpdated: number;
  epicLinksUpdated: number;
  epicsCreated: number;
  linearStatePushed: number;
  resumedFromCheckpoint: boolean;
  pausedForResume: boolean;
}

export interface LinearKanbanSyncResult {
  summary: string;
  stats: LinearKanbanSyncStats;
  complete: boolean;
}

export type LinearFetchFn = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LinearKanbanSyncDeps {
  stmts: Stmts;
  dataDir: string;
  apiKey: string;
  config: LinearKanbanSyncProjectConfig;
  log: (line: string) => void;
  /** Absolute timestamp (ms) — stop before this and checkpoint. */
  deadlineMs: number;
  fetchImpl?: LinearFetchFn;
}

function checkpointPath(dataDir: string, projectId: string): string {
  return path.join(dataDir, `linear-kanban-sync-${projectId}.json`);
}

export function readCheckpoint(
  dataDir: string,
  projectId: string,
): LinearKanbanSyncCheckpoint | null {
  const file = checkpointPath(dataDir, projectId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as LinearKanbanSyncCheckpoint;
    if (raw.version !== 1 || raw.projectId !== projectId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeCheckpoint(dataDir: string, cp: LinearKanbanSyncCheckpoint): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(checkpointPath(dataDir, cp.projectId), JSON.stringify(cp, null, 2), 'utf8');
}

export function clearCheckpoint(dataDir: string, projectId: string): void {
  const file = checkpointPath(dataDir, projectId);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
}

function linearPriorityToKanban(priority: number): 'urgent' | 'high' | 'medium' | 'low' {
  if (priority === 1) return 'urgent';
  if (priority === 2) return 'high';
  if (priority === 3) return 'medium';
  return 'low';
}

function parseMcsIdentifier(title: string): string | null {
  const m = title.match(MCS_TITLE_RE);
  return m ? m[1].toUpperCase() : null;
}

function truncateDescription(text: string | null, max = 2000): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function timeRemainingMs(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

function shouldPause(deadlineMs: number, bufferMs = 45_000): boolean {
  return timeRemainingMs(deadlineMs) < bufferMs;
}

const TEAM_ISSUES_QUERY = `
query TeamIssues($teamKey: String!, $after: String, $stateNames: [String!]!) {
  issues(
    first: 250
    after: $after
    filter: {
      team: { key: { eq: $teamKey } }
      state: { name: { in: $stateNames } }
    }
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      updatedAt
      state { id name }
      project { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_UPDATE_MUTATION = `
mutation IssueUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}`;

const TEAM_STATES_QUERY = `
query TeamStates($teamKey: String!) {
  workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
    nodes { id name }
  }
}`;

type TeamStatesResponse = {
  workflowStates: { nodes: Array<{ id: string; name: string }> };
};

export async function fetchLinearWorkflowStateIds(
  deps: Pick<LinearKanbanSyncDeps, 'apiKey' | 'config' | 'fetchImpl'>,
): Promise<Map<string, string>> {
  const data = await linearGqlRequest<TeamStatesResponse>(
    deps.apiKey,
    TEAM_STATES_QUERY,
    { teamKey: deps.config.teamKey },
    { fetchImpl: deps.fetchImpl },
  );
  const map = new Map<string, string>();
  for (const s of data.workflowStates.nodes) {
    map.set(s.name, s.id);
  }
  return map;
}

export async function linearGqlRequest<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  opts: { fetchImpl?: LinearFetchFn; timeoutMs?: number } = {},
): Promise<T> {
  const fetchFn: LinearFetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LINEAR_REQUEST_TIMEOUT_MS;
  const res = await fetchFn(LINEAR_GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Linear HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '));
  }
  if (!json.data) {
    throw new Error('Linear returned empty data');
  }
  return json.data;
}

type TeamIssuesResponse = {
  issues: {
    nodes: LinearIssueSnapshot[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function fetchLinearIssuesPage(
  deps: Pick<LinearKanbanSyncDeps, 'apiKey' | 'config' | 'fetchImpl'>,
  after: string | null,
): Promise<{ nodes: LinearIssueSnapshot[]; hasNextPage: boolean; endCursor: string | null }> {
  const data = await linearGqlRequest<TeamIssuesResponse>(
    deps.apiKey,
    TEAM_ISSUES_QUERY,
    {
      teamKey: deps.config.teamKey,
      after,
      stateNames: deps.config.linearActiveStates,
    },
    { fetchImpl: deps.fetchImpl },
  );
  const { nodes, pageInfo } = data.issues;
  return {
    nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
}

function columnByName(columns: KanbanColumnRow[], name: string): KanbanColumnRow | undefined {
  return columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

/** Next position at the bottom of a column (matches POST /board/cards create path). */
export function nextKanbanCardPositionInColumn(stmts: Stmts, columnId: string): number {
  const colCards = stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
  return colCards.length > 0 ? Math.max(...colCards.map((c) => c.position)) + 1 : 0;
}

function buildCardIndex(cards: KanbanCardRow[]): Map<string, KanbanCardRow> {
  const byIdentifier = new Map<string, KanbanCardRow>();
  for (const card of cards) {
    const id = parseMcsIdentifier(card.title);
    if (id) byIdentifier.set(id, card);
  }
  return byIdentifier;
}

function buildEpicIndex(epics: KanbanEpicRow[]): Map<string, KanbanEpicRow> {
  const byName = new Map<string, KanbanEpicRow>();
  for (const epic of epics) {
    byName.set(epic.name.toLowerCase().trim(), epic);
  }
  return byName;
}

function formatSummary(stats: LinearKanbanSyncStats, complete: boolean, paused: boolean): string {
  const lines = [
    '## Linear ↔ Kanban sync',
    '',
    `**Status:** ${complete ? 'complete' : paused ? 'paused (checkpoint saved)' : 'incomplete'}`,
    `**Issues fetched:** ${stats.issuesFetched}`,
    `**Cards created:** ${stats.cardsCreated}`,
    `**Cards updated (column/epic):** ${stats.cardsUpdated}`,
    `**Descriptions updated:** ${stats.descriptionsUpdated}`,
    `**Epic links updated:** ${stats.epicLinksUpdated}`,
    `**Epics created:** ${stats.epicsCreated}`,
    `**Kanban → Linear state pushes:** ${stats.linearStatePushed}`,
  ];
  if (stats.resumedFromCheckpoint) {
    lines.push('', '_Resumed from checkpoint._');
  }
  if (paused) {
    lines.push('', '_Stopped before deadline; next cron tick will resume._');
  }
  return lines.join('\n');
}

export async function runLinearKanbanSync(
  deps: LinearKanbanSyncDeps,
): Promise<LinearKanbanSyncResult> {
  const stats: LinearKanbanSyncStats = {
    issuesFetched: 0,
    cardsCreated: 0,
    cardsUpdated: 0,
    descriptionsUpdated: 0,
    epicLinksUpdated: 0,
    epicsCreated: 0,
    linearStatePushed: 0,
    resumedFromCheckpoint: false,
    pausedForResume: false,
  };

  let cp = readCheckpoint(deps.dataDir, deps.config.projectId);
  if (cp) stats.resumedFromCheckpoint = true;

  if (!cp) {
    cp = {
      version: 1,
      projectId: deps.config.projectId,
      phase: 'fetch',
      fetchCursor: null,
      fetchComplete: false,
      issues: [],
      syncIndex: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Phase 1: fetch all Linear issues (paginated, resumable) ─────────────
  while (!cp.fetchComplete) {
    if (shouldPause(deps.deadlineMs)) {
      cp.updatedAt = new Date().toISOString();
      writeCheckpoint(deps.dataDir, cp);
      stats.pausedForResume = true;
      stats.issuesFetched = cp.issues.length;
      return {
        complete: false,
        stats,
        summary: formatSummary(stats, false, true),
      };
    }

    deps.log(
      `[linear-kanban-sync] Fetching Linear page (cursor=${cp.fetchCursor ?? 'start'}, have=${cp.issues.length})`,
    );
    const page = await fetchLinearIssuesPage(deps, cp.fetchCursor);
    cp.issues.push(...page.nodes);
    stats.issuesFetched = cp.issues.length;
    deps.log(
      `[linear-kanban-sync] Fetched ${page.nodes.length} issues (total=${cp.issues.length})`,
    );

    if (page.hasNextPage && page.endCursor) {
      cp.fetchCursor = page.endCursor;
      cp.updatedAt = new Date().toISOString();
      writeCheckpoint(deps.dataDir, cp);
    } else {
      cp.fetchComplete = true;
      cp.fetchCursor = null;
      cp.phase = 'sync';
      cp.updatedAt = new Date().toISOString();
      writeCheckpoint(deps.dataDir, cp);
    }
  }

  const boardData = getOrCreateBoard(deps.stmts, deps.config.projectId);
  const { board, columns, cards, epics } = boardData;
  const cardByMcs = buildCardIndex(cards);
  let epicByName = buildEpicIndex(epics);

  const workflowStateIds = await fetchLinearWorkflowStateIds(deps);

  const doneColumn = columnByName(columns, deps.config.doneColumnName);

  // ── Phase 2: sync issues → kanban (resumable from syncIndex) ─────────────
  const issues = cp.issues;
  for (let i = cp.syncIndex; i < issues.length; i++) {
    if (shouldPause(deps.deadlineMs)) {
      cp.syncIndex = i;
      cp.updatedAt = new Date().toISOString();
      writeCheckpoint(deps.dataDir, cp);
      stats.pausedForResume = true;
      return {
        complete: false,
        stats,
        summary: formatSummary(stats, false, true),
      };
    }

    const issue = issues[i]!;
    const columnName = deps.config.linearStateToColumn[issue.state.name];
    if (!columnName) continue;

    const targetColumn = columnByName(columns, columnName);
    if (!targetColumn) {
      deps.log(
        `[linear-kanban-sync] warn: missing kanban column "${columnName}" — skip ${issue.identifier}`,
      );
      continue;
    }

    let epicId: string | null = null;
    if (issue.project?.name) {
      const epicKey = issue.project.name.toLowerCase().trim();
      let epic = epicByName.get(epicKey);
      if (!epic) {
        const epicUuid = uuidv4();
        const maxPos = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
        deps.stmts.createKanbanEpic.run(
          epicUuid,
          board.id,
          issue.project.name,
          null,
          '#6366F1',
          maxPos,
        );
        epic = deps.stmts.getKanbanEpic.get(epicUuid) as KanbanEpicRow;
        epics.push(epic);
        epicByName.set(epicKey, epic);
        stats.epicsCreated++;
        deps.log(`[linear-kanban-sync] Created epic "${issue.project.name}"`);
      }
      epicId = epic.id;
    }

    const cardTitle = `${issue.identifier}: ${issue.title}`;
    const priority = linearPriorityToKanban(issue.priority);
    const description = truncateDescription(issue.description);
    const existing = cardByMcs.get(issue.identifier.toUpperCase());

    if (!existing) {
      const id = uuidv4();
      const maxPos = nextKanbanCardPositionInColumn(deps.stmts, targetColumn.id);
      deps.stmts.createKanbanCard.run(
        id,
        targetColumn.id,
        board.id,
        cardTitle,
        description,
        priority,
        null,
        null,
        null,
        null,
        null,
        null,
        maxPos,
      );
      if (epicId) {
        const row = deps.stmts.getKanbanCard.get(id) as KanbanCardRow;
        deps.stmts.updateKanbanCard.run(
          row.title,
          row.description,
          row.priority,
          row.assignee,
          row.labels,
          row.session_id,
          row.github_issue_url,
          row.pr_url,
          epicId,
          row.assign_model ?? null,
          row.assign_engine ?? null,
          row.pr_base_branch ?? null,
          id,
        );
        stats.epicLinksUpdated++;
      }
      const created = deps.stmts.getKanbanCard.get(id) as KanbanCardRow;
      cardByMcs.set(issue.identifier.toUpperCase(), created);
      stats.cardsCreated++;
    } else {
      let changed = false;
      const desc = existing.description?.trim() ?? '';
      // Backfill only while the kanban card still has a stub description — once
      // it reaches 50 chars (from sync or a manual edit) we stop overwriting so
      // kanban-side edits are not clobbered by later Linear changes.
      if (description && description.length >= 50 && desc.length < 50) {
        deps.stmts.updateKanbanCard.run(
          existing.title,
          description,
          existing.priority,
          existing.assignee,
          existing.labels,
          existing.session_id,
          existing.github_issue_url,
          existing.pr_url,
          existing.epic_id,
          existing.assign_model ?? null,
          existing.assign_engine ?? null,
          existing.pr_base_branch ?? null,
          existing.id,
        );
        stats.descriptionsUpdated++;
        changed = true;
      }
      if (existing.column_id !== targetColumn.id) {
        const movePos = nextKanbanCardPositionInColumn(deps.stmts, targetColumn.id);
        deps.stmts.moveKanbanCard.run(targetColumn.id, movePos, existing.id);
        stats.cardsUpdated++;
        changed = true;
      }
      if (epicId && existing.epic_id !== epicId) {
        deps.stmts.updateKanbanCard.run(
          existing.title,
          existing.description,
          existing.priority,
          existing.assignee,
          existing.labels,
          existing.session_id,
          existing.github_issue_url,
          existing.pr_url,
          epicId,
          existing.assign_model ?? null,
          existing.assign_engine ?? null,
          existing.pr_base_branch ?? null,
          existing.id,
        );
        stats.epicLinksUpdated++;
        changed = true;
      }
      if (changed) {
        cardByMcs.set(
          issue.identifier.toUpperCase(),
          deps.stmts.getKanbanCard.get(existing.id) as KanbanCardRow,
        );
      }
    }

    if ((i + 1) % 50 === 0 || i === issues.length - 1) {
      cp.syncIndex = i + 1;
      cp.updatedAt = new Date().toISOString();
      writeCheckpoint(deps.dataDir, cp);
      deps.log(
        `[linear-kanban-sync] Synced batch through ${i + 1}/${issues.length} (created=${stats.cardsCreated}, updated=${stats.cardsUpdated})`,
      );
    }
  }

  // ── Phase 3: kanban → Linear (only when card is in Done, issue still active) ─
  if (doneColumn && !shouldPause(deps.deadlineMs)) {
    const freshCards = deps.stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
    for (const card of freshCards) {
      if (shouldPause(deps.deadlineMs)) break;
      if (card.column_id !== doneColumn.id) continue;
      const mcs = parseMcsIdentifier(card.title);
      if (!mcs) continue;
      const issue = cp.issues.find((x) => x.identifier.toUpperCase() === mcs);
      if (!issue) continue;
      // Only push when kanban shows Done but Linear is still in an active state.
      const doneStateId = workflowStateIds.get('Done');
      if (!doneStateId) continue;
      if (
        issue.state.name === 'Done' ||
        issue.state.name === 'Canceled' ||
        issue.state.name === 'Duplicate'
      ) {
        continue;
      }
      await linearGqlRequest(
        deps.apiKey,
        ISSUE_UPDATE_MUTATION,
        { id: issue.id, stateId: doneStateId },
        { fetchImpl: deps.fetchImpl },
      );
      stats.linearStatePushed++;
      deps.log(`[linear-kanban-sync] Pushed ${issue.identifier} → Done in Linear`);
    }
  }

  clearCheckpoint(deps.dataDir, deps.config.projectId);
  stats.issuesFetched = issues.length;
  return {
    complete: true,
    stats,
    summary: formatSummary(stats, true, false),
  };
}
