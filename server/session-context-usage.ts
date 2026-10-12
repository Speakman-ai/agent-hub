/**
 * Context-window usage for a chat session, broken down by what fills it.
 *
 * Two inputs feed the report:
 *   1. The Hub-built system prompt for the latest turn, split into categories
 *      by its `## ` section headings (recorded at spawn time).
 *   2. The engine's own token count for the latest model step. Only Claude
 *      Code reports it per step (`message.usage` on assistant frames); other
 *      engines fall back to a character-based estimate of the transcript.
 *
 * Token counts for Hub sections are estimates (~4 chars per token). The engine
 * share is derived once, from the first step of a fresh CLI session:
 * reported total minus the Hub prompt minus the first user message.
 */
import type Database from 'better-sqlite3';

export const CONTEXT_CATEGORY_KEYS = [
  'system',
  'rules',
  'skills',
  'wiki',
  'memory',
  'engine',
  'conversation',
] as const;
export type ContextCategoryKey = (typeof CONTEXT_CATEGORY_KEYS)[number];
export type PromptCategoryKey = Exclude<ContextCategoryKey, 'engine' | 'conversation'>;

export const CONTEXT_CATEGORY_LABELS: Record<ContextCategoryKey, string> = {
  system: 'System prompt',
  rules: 'Rules & context files',
  skills: 'Skills',
  wiki: 'Wiki & retrieval',
  memory: 'Memory',
  engine: 'Engine prompt & tools',
  conversation: 'Conversation',
};

const CHARS_PER_TOKEN = 4;

export function estimateTokens(charsOrText: number | string): number {
  const chars = typeof charsOrText === 'number' ? charsOrText : charsOrText.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// ── Prompt classification ────────────────────────────────────────────────

type Block = { category: PromptCategoryKey; sticky: 'none' | 'rules' | 'skill' };

const RULES_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'CLAUDE.md', 'USER.md', 'TOOLS.md'];

/** Headings that open a non-system category. Matched as a prefix. */
function categoryStart(title: string): Block | null {
  if (RULES_FILES.some((f) => title === f || title.startsWith(`${f} `))) {
    return { category: 'rules', sticky: 'rules' };
  }
  if (title === 'Identity Reminder') return { category: 'rules', sticky: 'none' };
  if (title.startsWith('Loaded Skill:')) return { category: 'skills', sticky: 'skill' };
  if (title === 'Available Skills') return { category: 'skills', sticky: 'none' };
  if (
    title.startsWith('Project Wiki (') ||
    title === 'Retrieved Wiki Context' ||
    title === 'Retrieved Project Code' ||
    title === 'Wiki Documentation Guidelines'
  ) {
    return { category: 'wiki', sticky: 'none' };
  }
  if (
    title.startsWith('MEMORY.md') ||
    title.startsWith("Today's Notes") ||
    title.startsWith("Yesterday's Notes")
  ) {
    return { category: 'memory', sticky: 'none' };
  }
  return null;
}

/**
 * Hub-authored instruction headings (exact titles) that return to the system
 * category. Anything not listed inherits the current block, which is how the
 * sub-headings inside AGENTS.md / CLAUDE.md / MEMORY.md stay with their file.
 */
const SYSTEM_HEADINGS = new Set([
  'Project agent roster (same project)',
  'Browser Automation Available',
  'Preview screenshots',
  'Session Startup Setup',
  'Project AWS',
  'ReAct Loop',
  'ReAct Loop (host tools)',
  'Kanban Board — Task Self-Reporting',
  'Worktree preview',
  'Finalize Code Changes — No Direct Ship',
  'Development Lifecycle — GitHub-Connected Project',
  'Development — Workflow mode',
  'Git Workflow',
  "Bias to Action — Don't Ask, Just Build",
  "Research Questions — Answer on the Spot, Don't Card It",
  "No Shell — Don't Tell the User to Run Commands",
  "Deliver Files as Artifacts — Don't Paste Them Into Chat",
  'Long-Running Commands — Start Them as Hub-Owned Background Shells',
  'Web Search — Required for Opinions, Best Practices & Recommendations',
  'External API Documentation — Always Verify',
  'Writing Style: No AI Slop',
  'Writing Style (reminder)',
  'Asking the User Multi-Choice Questions',
  'Requesting Secrets & Credentials Securely',
  'Requesting Secrets Securely (still available)',
  'Agent Hub — Shipping (do not override)',
  'Active Pull Request',
  'Multi-Agent Session — Advisory Role',
  'Memory Instructions',
]);

/**
 * A rules file (CLAUDE.md especially) can quote Hub headings verbatim, so
 * inside one only the section that always follows the context files ends it.
 */
function endsRulesBlock(title: string): boolean {
  return title === 'ReAct Loop' || title === 'ReAct Loop (host tools)';
}

/** Split a Hub-built prompt into per-category character counts. */
export function classifyPromptSections(prompt: string): Record<PromptCategoryKey, number> {
  const out: Record<PromptCategoryKey, number> = {
    system: 0,
    rules: 0,
    skills: 0,
    wiki: 0,
    memory: 0,
  };
  if (!prompt) return out;
  let block: Block = { category: 'system', sticky: 'none' };
  let inFence = false;
  const lines = prompt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^## (.+?)\s*$/.exec(line);
    if (m) {
      const title = m[1];
      const start = categoryStart(title);
      if (start) {
        block = start;
      } else if (SYSTEM_HEADINGS.has(title)) {
        if (block.sticky === 'none' || (block.sticky === 'rules' && endsRulesBlock(title))) {
          block = { category: 'system', sticky: 'none' };
        }
      }
    }
    // +1 for the newline consumed by split, except after the last line.
    out[block.category] += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return out;
}

// ── Context window sizes ─────────────────────────────────────────────────

/**
 * Fallback context window for an engine/model pair, or null when unknown.
 * Claude Code's real window comes from `result.modelUsage[*].contextWindow`
 * (see `contextWindowFromClaudeModelUsage`); this guess only covers turns
 * that haven't finished yet. Some plans get 1M on Opus without `[1m]`, so
 * the report also widens it when a measured total exceeds the guess.
 */
export function contextWindowForModel(
  engine: string,
  model: string | null | undefined,
): number | null {
  const m = (model || '').toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  if (engine === 'claude-code') return 200_000;
  if (engine === 'gemini-cli' || m.includes('gemini')) return 1_048_576;
  if (engine === 'codex-cli' || m.startsWith('gpt-5') || m.includes('codex')) return 272_000;
  if (engine === 'grok-cli' || m.includes('grok')) return 256_000;
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) {
    return 200_000;
  }
  return null;
}

// ── Snapshot persistence ─────────────────────────────────────────────────

export interface ContextUsageSnapshot {
  engine: string;
  model: string | null;
  /** Estimated tokens per Hub prompt category for the latest turn. */
  promptTokens: Record<PromptCategoryKey, number>;
  /** Estimated tokens of the latest user turn as sent to the CLI. */
  userTurnTokens: number;
  /** True until the first model step of a fresh CLI session lands. */
  awaitingBaseline: boolean;
  /** Engine-internal share (its own system prompt + tool schemas), once derived. */
  engineTokens: number | null;
  /** Total context the engine reported for the latest model step. */
  reportedTokens: number | null;
  /** Context window the engine reported for this model, when it does. */
  contextWindow?: number | null;
  updatedAt: string;
}

function readSnapshot(db: Database.Database, sessionId: string): ContextUsageSnapshot | null {
  const row = db
    .prepare('SELECT data FROM session_context_usage WHERE session_id = ?')
    .get(sessionId) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as ContextUsageSnapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(db: Database.Database, sessionId: string, snap: ContextUsageSnapshot): void {
  db.prepare(
    `INSERT INTO session_context_usage (session_id, data, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(snap));
}

export function getContextUsageSnapshot(
  db: Database.Database,
  sessionId: string,
): ContextUsageSnapshot | null {
  return readSnapshot(db, sessionId);
}

/** Record the prompt a turn is about to send. Call once per CLI spawn. */
export function recordContextTurn(
  db: Database.Database,
  sessionId: string,
  input: {
    engine: string;
    model: string | null;
    systemPrompt: string;
    userTurn: string;
    /** True when this spawn starts a fresh CLI conversation (no resume). */
    freshEngineSession: boolean;
    now?: Date;
  },
): ContextUsageSnapshot {
  const prev = readSnapshot(db, sessionId);
  const chars = classifyPromptSections(input.systemPrompt);
  const promptTokens = {
    system: estimateTokens(chars.system),
    rules: estimateTokens(chars.rules),
    skills: estimateTokens(chars.skills),
    wiki: estimateTokens(chars.wiki),
    memory: estimateTokens(chars.memory),
  };
  const sameEngine = prev?.engine === input.engine;
  const sameModel = sameEngine && prev?.model === input.model;
  const snap: ContextUsageSnapshot = {
    engine: input.engine,
    model: input.model,
    promptTokens,
    userTurnTokens: estimateTokens(input.userTurn),
    awaitingBaseline: input.freshEngineSession || !sameEngine || prev?.engineTokens == null,
    engineTokens: sameEngine && !input.freshEngineSession ? (prev?.engineTokens ?? null) : null,
    reportedTokens: sameEngine && !input.freshEngineSession ? (prev?.reportedTokens ?? null) : null,
    contextWindow: sameModel ? (prev?.contextWindow ?? null) : null,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  // A resumed session whose baseline was never derived can't recover it
  // (the prior conversation is mixed in), so stop waiting for it.
  if (!input.freshEngineSession && prev?.engineTokens == null) snap.awaitingBaseline = false;
  writeSnapshot(db, sessionId, snap);
  return snap;
}

function promptTotal(snap: ContextUsageSnapshot): number {
  return Object.values(snap.promptTokens).reduce((a, b) => a + b, 0);
}

/**
 * Record the engine-reported context size for one model step. Returns true
 * when the stored snapshot changed.
 */
export function recordReportedContext(
  db: Database.Database,
  sessionId: string,
  contextTokens: number,
  now: Date = new Date(),
): boolean {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  const snap = readSnapshot(db, sessionId);
  if (!snap) return false;
  if (snap.reportedTokens === contextTokens && !snap.awaitingBaseline) return false;
  if (snap.awaitingBaseline) {
    snap.engineTokens = Math.max(0, contextTokens - promptTotal(snap) - snap.userTurnTokens);
    snap.awaitingBaseline = false;
  }
  snap.reportedTokens = contextTokens;
  snap.updatedAt = now.toISOString();
  writeSnapshot(db, sessionId, snap);
  return true;
}

/** Record the context window the engine reported for the session's model. */
export function recordReportedContextWindow(
  db: Database.Database,
  sessionId: string,
  contextWindow: number,
): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const snap = readSnapshot(db, sessionId);
  if (!snap || snap.contextWindow === contextWindow) return false;
  snap.contextWindow = contextWindow;
  writeSnapshot(db, sessionId, snap);
  return true;
}

/** Model id without a `[1m]`-style suffix or a trailing `-YYYYMMDD` date. */
function baseModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * The parent model's `contextWindow` from a Claude `result.modelUsage` map.
 * Subagents on other models add their own entries, so the entry must match
 * the parent's model. With no parent model known, only a single-entry map is
 * unambiguous; otherwise this returns null and the caller keeps its fallback.
 */
export function contextWindowFromClaudeModelUsage(
  modelUsage: unknown,
  parentModel: string | null,
): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const windowOf = (entry: unknown): number | null => {
    const w = (entry as Record<string, unknown> | null)?.contextWindow;
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
  };
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  if (parentModel) {
    const exact = entries.find(([id]) => id === parentModel);
    if (exact) return windowOf(exact[1]);
    const base = baseModelId(parentModel);
    const loose = entries.filter(([id]) => baseModelId(id) === base);
    return loose.length === 1 ? windowOf(loose[0][1]) : null;
  }
  return entries.length === 1 ? windowOf(entries[0][1]) : null;
}

/** Sum of input-side tokens on a Claude `message.usage` object. */
export function contextTokensFromClaudeUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (k: string) =>
    typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0;
  const total =
    num('input_tokens') +
    num('cache_creation_input_tokens') +
    num('cache_read_input_tokens') +
    num('output_tokens');
  return total > 0 ? total : null;
}

// ── Report ───────────────────────────────────────────────────────────────

export interface ContextUsageCategory {
  key: ContextCategoryKey;
  label: string;
  tokens: number;
}

export interface ContextUsageReport {
  sessionId: string;
  engine: string | null;
  model: string | null;
  /** `reported`: engine gave a token count. `estimated`: chars/4 only. `none`: no turn recorded yet. */
  source: 'reported' | 'estimated' | 'none';
  totalTokens: number;
  contextWindow: number | null;
  percent: number | null;
  categories: ContextUsageCategory[];
  updatedAt: string | null;
}

/** Scale category tokens down in place so they sum to exactly `total`. */
function fitToTotal(categories: ContextUsageCategory[], total: number): void {
  const sum = categories.reduce((a, c) => a + c.tokens, 0);
  if (sum <= 0) return;
  let assigned = 0;
  for (const c of categories) {
    c.tokens = Math.floor((c.tokens * total) / sum);
    assigned += c.tokens;
  }
  // Hand the rounding remainder to the largest category.
  const largest = categories.reduce((a, c) => (c.tokens > a.tokens ? c : a), categories[0]);
  largest.tokens += total - assigned;
}

export function buildContextUsageReport(input: {
  sessionId: string;
  engine: string | null;
  model: string | null;
  snapshot: ContextUsageSnapshot | null;
  /** Characters of persisted transcript, used when the engine reports nothing. */
  transcriptChars: number;
}): ContextUsageReport {
  const { snapshot } = input;
  const engine = snapshot?.engine ?? input.engine;
  const model = input.model ?? snapshot?.model ?? null;
  let contextWindow =
    snapshot?.contextWindow ?? (engine ? contextWindowForModel(engine, model) : null);

  const categories: ContextUsageCategory[] = [];
  const push = (key: ContextCategoryKey, tokens: number) => {
    categories.push({
      key,
      label: CONTEXT_CATEGORY_LABELS[key],
      tokens: Math.max(0, Math.round(tokens)),
    });
  };

  let source: ContextUsageReport['source'];
  let total: number;
  if (!snapshot) {
    source = input.transcriptChars > 0 ? 'estimated' : 'none';
    total = estimateTokens(input.transcriptChars);
    if (total > 0) push('conversation', total);
  } else {
    for (const key of ['system', 'rules', 'skills', 'wiki', 'memory'] as const) {
      push(key, snapshot.promptTokens[key]);
    }
    const hub = promptTotal(snapshot);
    if (snapshot.reportedTokens != null) {
      source = 'reported';
      total = snapshot.reportedTokens;
      if (snapshot.engineTokens != null) push('engine', snapshot.engineTokens);
      const estimated = categories.reduce((a, c) => a + c.tokens, 0);
      if (estimated > total) {
        // The measured total wins. Estimates (or an engine share derived
        // before the context shrank) that overshoot it are scaled to fit.
        fitToTotal(categories, total);
        push('conversation', 0);
      } else {
        push('conversation', total - estimated);
      }
      // A step can't exceed its window, so a larger measured total means
      // the guessed window is wrong (plans with automatic 1M context).
      if (snapshot.contextWindow == null && contextWindow != null && total > contextWindow) {
        contextWindow = engine === 'claude-code' ? 1_000_000 : null;
      }
    } else {
      source = 'estimated';
      const conversation = Math.max(estimateTokens(input.transcriptChars), snapshot.userTurnTokens);
      push('conversation', conversation);
      total = hub + conversation;
    }
  }

  const percent =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((total / contextWindow) * 1000) / 10)
      : null;
  return {
    sessionId: input.sessionId,
    engine,
    model,
    source,
    totalTokens: total,
    contextWindow,
    percent,
    categories,
    updatedAt: snapshot?.updatedAt ?? null,
  };
}
