/**
 * Unified ReAct / auto-continuation budgets (project defaults + epic overrides).
 *
 * Token chain caps (`maxReactChainTokens`) only accrue when the active engine’s
 * JSONL stream includes usage on terminal `result` events (Claude / Codex /
 * Gemini paths today). Cursor Agent’s `result` shape does not carry token
 * counts, so that cap is effectively inactive there until the CLI exposes them.
 */

import { MAX_WIKI_RAG_CALLS_PER_SESSION } from './wiki-rag.js';
import { MAX_WEB_SEARCH_CALLS_PER_SESSION } from './web-search.js';
import type { KanbanEpicRow, Project } from './types.js';

/** Hard ceiling for how many ReAct actions a single block may list (parse-time guard). */
export const HOST_REACT_ACTIONS_PARSE_CAP = 12;

export interface OrchestrationBudgetsPartial {
  maxContinuationDepth?: number;
  /** Wall-clock budget for one user-turn ReAct chain (ms). 0 = unlimited. */
  maxReactWallClockMs?: number;
  /** Max model invocations (CLI rounds) in one chain. 0 = unlimited (depth cap still applies). */
  maxReactModelTurns?: number;
  /** Max host CLI spawns in one chain. 0 = unlimited. */
  maxReactChainCliSpawns?: number;
  /** Max agent Bash/shell tool_use events summed across the chain. 0 = unlimited. */
  maxReactChainAgentBashTools?: number;
  /**
   * Max input+output tokens summed across the chain when the engine reports
   * usage on `result` events (see module note — Cursor often omits these).
   * 0 = unlimited.
   */
  maxReactChainTokens?: number;
  maxReactActionsPerTurn?: number;
  maxWikiRagCallsPerSession?: number;
  maxWebSearchCallsPerSession?: number;
}

export interface ResolvedOrchestrationBudgets {
  maxContinuationDepth: number;
  maxReactWallClockMs: number;
  maxReactModelTurns: number;
  maxReactChainCliSpawns: number;
  maxReactChainAgentBashTools: number;
  maxReactChainTokens: number;
  maxReactActionsPerTurn: number;
  maxWikiRagCallsPerSession: number;
  maxWebSearchCallsPerSession: number;
}

export const DEFAULT_ORCHESTRATION_BUDGETS: ResolvedOrchestrationBudgets = {
  maxContinuationDepth: 4,
  maxReactWallClockMs: 0,
  maxReactModelTurns: 0,
  maxReactChainCliSpawns: 0,
  maxReactChainAgentBashTools: 0,
  maxReactChainTokens: 0,
  maxReactActionsPerTurn: 6,
  maxWikiRagCallsPerSession: MAX_WIKI_RAG_CALLS_PER_SESSION,
  maxWebSearchCallsPerSession: MAX_WEB_SEARCH_CALLS_PER_SESSION,
};

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function numOptional(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function sanitizeOrchestrationBudgetsPartial(
  raw: unknown,
): OrchestrationBudgetsPartial | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: OrchestrationBudgetsPartial = {};
  const d = numOptional(o.maxContinuationDepth, 0, 32);
  if (d !== undefined) out.maxContinuationDepth = d;
  const w = numOptional(o.maxReactWallClockMs, 0, 86_400_000);
  if (w !== undefined) out.maxReactWallClockMs = w;
  const mt = numOptional(o.maxReactModelTurns, 0, 256);
  if (mt !== undefined) out.maxReactModelTurns = mt;
  const sp = numOptional(o.maxReactChainCliSpawns, 0, 256);
  if (sp !== undefined) out.maxReactChainCliSpawns = sp;
  const ba = numOptional(o.maxReactChainAgentBashTools, 0, 10_000);
  if (ba !== undefined) out.maxReactChainAgentBashTools = ba;
  const tk = numOptional(o.maxReactChainTokens, 0, 100_000_000);
  if (tk !== undefined) out.maxReactChainTokens = tk;
  const ac = numOptional(o.maxReactActionsPerTurn, 1, HOST_REACT_ACTIONS_PARSE_CAP);
  if (ac !== undefined) out.maxReactActionsPerTurn = ac;
  const wiki = numOptional(o.maxWikiRagCallsPerSession, 0, 10_000);
  if (wiki !== undefined) out.maxWikiRagCallsPerSession = wiki;
  const web = numOptional(o.maxWebSearchCallsPerSession, 0, 10_000);
  if (web !== undefined) out.maxWebSearchCallsPerSession = web;
  return Object.keys(out).length ? out : null;
}

export function parseEpicOrchestrationBudgetsJson(
  json: string | null | undefined,
): OrchestrationBudgetsPartial | null {
  if (json == null || !String(json).trim()) return null;
  try {
    const parsed = JSON.parse(String(json)) as unknown;
    return sanitizeOrchestrationBudgetsPartial(parsed);
  } catch {
    return null;
  }
}

export function mergeOrchestrationBudgets(
  base: ResolvedOrchestrationBudgets,
  patch: OrchestrationBudgetsPartial | null | undefined,
): ResolvedOrchestrationBudgets {
  if (!patch) return { ...base };
  return {
    maxContinuationDepth: patch.maxContinuationDepth ?? base.maxContinuationDepth,
    maxReactWallClockMs: patch.maxReactWallClockMs ?? base.maxReactWallClockMs,
    maxReactModelTurns: patch.maxReactModelTurns ?? base.maxReactModelTurns,
    maxReactChainCliSpawns: patch.maxReactChainCliSpawns ?? base.maxReactChainCliSpawns,
    maxReactChainAgentBashTools:
      patch.maxReactChainAgentBashTools ?? base.maxReactChainAgentBashTools,
    maxReactChainTokens: patch.maxReactChainTokens ?? base.maxReactChainTokens,
    maxReactActionsPerTurn: patch.maxReactActionsPerTurn ?? base.maxReactActionsPerTurn,
    maxWikiRagCallsPerSession: patch.maxWikiRagCallsPerSession ?? base.maxWikiRagCallsPerSession,
    maxWebSearchCallsPerSession:
      patch.maxWebSearchCallsPerSession ?? base.maxWebSearchCallsPerSession,
  };
}

export function finalizeResolvedBudgets(
  b: ResolvedOrchestrationBudgets,
): ResolvedOrchestrationBudgets {
  return {
    maxContinuationDepth: num(
      b.maxContinuationDepth,
      0,
      64,
      DEFAULT_ORCHESTRATION_BUDGETS.maxContinuationDepth,
    ),
    maxReactWallClockMs: num(b.maxReactWallClockMs, 0, 86_400_000, 0),
    maxReactModelTurns: num(b.maxReactModelTurns, 0, 256, 0),
    maxReactChainCliSpawns: num(b.maxReactChainCliSpawns, 0, 256, 0),
    maxReactChainAgentBashTools: num(b.maxReactChainAgentBashTools, 0, 10_000, 0),
    maxReactChainTokens: num(b.maxReactChainTokens, 0, 100_000_000, 0),
    maxReactActionsPerTurn: Math.min(
      HOST_REACT_ACTIONS_PARSE_CAP,
      Math.max(1, num(b.maxReactActionsPerTurn, 1, HOST_REACT_ACTIONS_PARSE_CAP, 6)),
    ),
    maxWikiRagCallsPerSession: num(
      b.maxWikiRagCallsPerSession,
      0,
      10_000,
      MAX_WIKI_RAG_CALLS_PER_SESSION,
    ),
    maxWebSearchCallsPerSession: num(
      b.maxWebSearchCallsPerSession,
      0,
      10_000,
      MAX_WEB_SEARCH_CALLS_PER_SESSION,
    ),
  };
}

export function projectOrchestrationDefaults(project: Project): ResolvedOrchestrationBudgets {
  const fromFile = sanitizeOrchestrationBudgetsPartial(
    (project as Record<string, unknown>).orchestrationBudgets,
  );
  return finalizeResolvedBudgets(
    mergeOrchestrationBudgets(DEFAULT_ORCHESTRATION_BUDGETS, fromFile),
  );
}

export function resolveOrchestrationBudgets(
  project: Project,
  epic: KanbanEpicRow | null | undefined,
): ResolvedOrchestrationBudgets {
  const projectBase = projectOrchestrationDefaults(project);
  const epicPatch = epic
    ? parseEpicOrchestrationBudgetsJson(
        (epic as KanbanEpicRow & { orchestration_budgets_json?: string | null })
          .orchestration_budgets_json,
      )
    : null;
  return finalizeResolvedBudgets(mergeOrchestrationBudgets(projectBase, epicPatch));
}

export interface ReactContinuationBudgetInput {
  reactLoopEnabled: boolean;
  continuationContextAdded: boolean;
  controlFlowPresent: boolean;
  continuationDepth: number;
  chainStartedAtMs: number;
  nowMs: number;
  completedCliSpawns: number;
  chainBashTools: number;
  chainTokensUsed: number;
  budgets: ResolvedOrchestrationBudgets;
}

export interface ReactContinuationBudgetResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Decide whether the host may schedule another auto-continuation turn after
 * injecting ReAct context. All checks are inclusive of the just-finished CLI
 * round (`completedCliSpawns`, token/bash tallies, etc.).
 */
export function evaluateReactContinuationBudgets(
  input: ReactContinuationBudgetInput,
): ReactContinuationBudgetResult {
  const reasons: string[] = [];
  const {
    reactLoopEnabled,
    continuationContextAdded,
    controlFlowPresent,
    continuationDepth,
    chainStartedAtMs,
    nowMs,
    completedCliSpawns,
    chainBashTools,
    chainTokensUsed,
    budgets,
  } = input;

  if (!reactLoopEnabled || !continuationContextAdded || controlFlowPresent) {
    return { ok: false, reasons: [] };
  }

  if (continuationDepth >= budgets.maxContinuationDepth) {
    reasons.push(`continuation depth ${continuationDepth} >= max ${budgets.maxContinuationDepth}`);
  }

  const completedModelTurns = continuationDepth + 1;
  if (budgets.maxReactModelTurns > 0 && completedModelTurns >= budgets.maxReactModelTurns) {
    reasons.push(`model turns ${completedModelTurns} >= max ${budgets.maxReactModelTurns}`);
  }

  if (budgets.maxReactWallClockMs > 0) {
    const elapsed = nowMs - chainStartedAtMs;
    if (elapsed >= budgets.maxReactWallClockMs) {
      reasons.push(`wall clock ${elapsed}ms >= max ${budgets.maxReactWallClockMs}ms`);
    }
  }

  if (budgets.maxReactChainCliSpawns > 0 && completedCliSpawns >= budgets.maxReactChainCliSpawns) {
    reasons.push(`CLI spawns ${completedCliSpawns} >= max ${budgets.maxReactChainCliSpawns}`);
  }

  if (
    budgets.maxReactChainAgentBashTools > 0 &&
    chainBashTools >= budgets.maxReactChainAgentBashTools
  ) {
    reasons.push(
      `agent Bash tool calls ${chainBashTools} >= max ${budgets.maxReactChainAgentBashTools}`,
    );
  }

  if (budgets.maxReactChainTokens > 0 && chainTokensUsed >= budgets.maxReactChainTokens) {
    reasons.push(`chain tokens ${chainTokensUsed} >= max ${budgets.maxReactChainTokens}`);
  }

  return { ok: reasons.length === 0, reasons };
}

export function isAgentShellToolName(tool: string): boolean {
  const t = (tool || '').trim().toLowerCase();
  return t === 'bash' || t === 'shell' || t === 'command_execution';
}

export function addResultEventTokens(
  prev: number,
  inputTok: number | null | undefined,
  outputTok: number | null | undefined,
): number {
  const a = typeof inputTok === 'number' && Number.isFinite(inputTok) ? inputTok : 0;
  const b = typeof outputTok === 'number' && Number.isFinite(outputTok) ? outputTok : 0;
  return prev + Math.max(0, a) + Math.max(0, b);
}
