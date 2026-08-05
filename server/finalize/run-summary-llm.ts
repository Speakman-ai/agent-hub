/**
 * run-summary-llm.ts — LLM narrative for the end-of-run Finalize summary.
 *
 * The deterministic half of the summary (commit subjects, diff stat, reviewer
 * findings) is always available. What a human actually wants on top of that is
 * prose describing the change as a whole and a concrete list of things to poke
 * at by hand before merging — neither of which can be derived from git.
 *
 * This mirrors `pr-summary-llm.ts`: fetch-based (no SDK), key-gated, time-boxed,
 * and it NEVER throws. It returns `null` on any failure so the caller falls back
 * to the deterministic sections alone.
 *
 * ## Why OpenAI only
 *
 * There is deliberately **no Anthropic branch here**. Per `server/config.ts`
 * (see the "AI provider credentials" comment above `openaiApiKey`), Claude /
 * Cursor / Codex credentials are strictly **per-account** — encrypted in
 * `orgs.db` and used only so an agent spawn runs under the acting user's own
 * login. `AppConfig` has no host-wide `anthropicApiKey` by design, so an
 * Anthropic code path here would be permanently unreachable and would only
 * mislead readers into thinking a provider toggle exists.
 *
 * `openaiApiKey` is the sanctioned host-wide key for exactly this class of
 * background, non-spawn LLM work — it already powers Whisper transcription and
 * LLM session titles. Billing a user's personal Claude credentials for an
 * automatic background summary would be a different (and much larger) policy
 * decision. If a host-wide Anthropic key is ever introduced, add the branch
 * then. (`pr-summary-llm.ts` still carries a vestigial Anthropic branch that
 * nothing populates — a separate cleanup.)
 */

import { clipUtf8StringToMaxBytes } from '../utf8-clip.js';
import { DEFAULT_TITLE_OPENAI_MODEL } from '../session-title.js';
import type { FinalizeReviewRoundSummary } from './run-summary-data.js';

/** Total byte budget for the context fed to the model. */
const MAX_INPUT_BYTES = 10_000;
/** Per-commit body budget so one chatty commit can't crowd out the rest. */
const MAX_COMMIT_BODY_BYTES = 800;
/** Per-finding budget so one essay-length review note can't crowd out the rest. */
const MAX_FINDING_BYTES = 600;
/** Cap on the manual-testing checklist — a 30-item list is noise, not a checklist. */
export const MAX_MANUAL_TESTING_STEPS = 8;
/**
 * Cap on the follow-up list. Deliberately tighter than the testing checklist:
 * follow-ups are the things a human must actually go and do, and a list that
 * long stops reading as a to-do and starts reading as prose.
 */
export const MAX_FOLLOW_UP_STEPS = 6;
/** Cap on a single checklist line. */
const MAX_MANUAL_TESTING_STEP_LEN = 200;

export interface RunSummaryCommit {
  subject: string;
  body?: string;
}

export interface FinalizeRunSummaryNarrative {
  /** 1–4 sentences describing the whole change. May be empty. */
  summary: string;
  /** What a human should verify by hand. May be empty. */
  manualTesting: string[];
  /**
   * Out-of-band actions the change needs to actually work once it lands — a
   * migration to run, an env var to set, a backfill script, a service restart.
   *
   * Deliberately separate from {@link manualTesting}: that list is "go check
   * this still works", this one is "the change is not finished until you do
   * this". Merging them buries the second kind, which is the exact failure the
   * summary exists to prevent — an operator reading a checklist of things to
   * click and never noticing the migration nobody ran.
   */
  followUps: string[];
  /** 1–2 sentences on what the reviewer flagged. Empty when nothing was raised. */
  reviewNotes: string;
}

export interface FinalizeRunSummaryLlmOptions {
  cardTitle?: string | null;
  cardDescription?: string | null;
  /** Commits on the branch, newest first (as collected by `collectPrCommits`). */
  commits: readonly RunSummaryCommit[];
  /** Output of `git diff --stat base...HEAD`. */
  diffStat?: string | null;
  /** Every review round the run went through, oldest first. */
  reviewRounds?: readonly FinalizeReviewRoundSummary[];
  /**
   * Host-wide OpenAI key. The only provider wired here on purpose — see the
   * "Why OpenAI only" note at the top of this file.
   */
  openaiApiKey?: string | null;
  openaiModel?: string;
  /** Abort after this many ms. Default: 15000. */
  timeoutMs?: number;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const RUN_SUMMARY_PROMPT = [
  'You brief a software engineer on a change that just passed CI and code review',
  'and is waiting to be pushed. You are given the originating task, every commit',
  'on the branch (newest first), the changed-files stat, and every note the code',
  'reviewer left across all review rounds.',
  '',
  'Respond with ONLY a JSON object, no prose, no code fence:',
  '{"summary": string, "reviewNotes": string, "manualTesting": [string],',
  ' "followUps": [string]}',
  '',
  'Rules:',
  '- summary: 1 to 4 sentences of plain prose describing what the change does and',
  '  why, covering the through-line across all commits. No headings, no bullets.',
  '- reviewNotes: 1 to 2 sentences on what the reviewer actually flagged and how it',
  '  was resolved. Empty string when the reviewer raised nothing.',
  '- manualTesting: up to 8 short imperative checks a human should run by hand',
  '  before merging, each grounded in the actual diff (name the real screen, route,',
  '  endpoint, or command). Prefer things automated tests cannot cover: UI states,',
  '  destructive actions, third-party integrations, migrations, config changes.',
  '  Return an empty array when the diff is genuinely not manually testable',
  '  (pure refactor, test-only change, docs).',
  '- followUps: up to 6 actions someone must take OUTSIDE of merging for the',
  '  change to work — run a migration, run a one-off or backfill script, set an',
  '  env var or secret, update deployment config, restart or redeploy a service,',
  '  flip a feature flag, rotate a credential, install a new dependency on a',
  '  host. Write each as an imperative instruction, and quote the literal',
  '  command in backticks when the diff contains one. These are actions, not',
  '  verification: anything phrased as "check", "verify", or "confirm" belongs',
  '  in manualTesting instead. Only list steps the diff itself implies — return',
  '  an empty array when merging is genuinely all that is required.',
  '- Do not invent changes, findings, or files that are not in the input.',
].join('\n');

function formatAnchor(f: { lineStart: number | null; lineEnd: number | null }): string {
  if (f.lineStart == null) return 'file-level';
  if (f.lineEnd == null || f.lineEnd === f.lineStart) return `L${f.lineStart}`;
  return `L${f.lineStart}-${f.lineEnd}`;
}

/** Build the user-content blob: task + commits + diff stat + review history. */
export function buildRunSummaryInput(opts: FinalizeRunSummaryLlmOptions): string {
  const parts: string[] = [];

  const cardTitle = (opts.cardTitle ?? '').replace(/\s+/g, ' ').trim();
  const cardDescription = (opts.cardDescription ?? '').trim();
  if (cardTitle) parts.push(`Task title: ${cardTitle}`);
  if (cardDescription) {
    parts.push(`Task description:\n${clipUtf8StringToMaxBytes(cardDescription, 2_000)}`);
  }

  const commits = (opts.commits ?? []).filter(
    (c): c is RunSummaryCommit =>
      !!c && typeof c.subject === 'string' && c.subject.trim().length > 0,
  );
  if (commits.length) {
    const lines = ['Commits (newest first):'];
    for (const c of commits) {
      lines.push(`- ${c.subject.trim()}`);
      const body = (c.body ?? '').trim();
      if (body) {
        const clipped = clipUtf8StringToMaxBytes(body, MAX_COMMIT_BODY_BYTES);
        for (const line of clipped.split('\n')) lines.push(`    ${line}`);
      }
    }
    parts.push(lines.join('\n'));
  }

  const diffStat = (opts.diffStat ?? '').trim();
  if (diffStat) parts.push(`Changed files:\n${clipUtf8StringToMaxBytes(diffStat, 2_500)}`);

  const rounds = (opts.reviewRounds ?? []).filter((r) => !!r);
  if (rounds.length) {
    const lines = ['Code review history:'];
    for (const round of rounds) {
      const verdict = round.verdict === 'approved' ? 'approved' : 'changes requested';
      lines.push(`- Round ${round.round}: ${verdict}`);
      for (const f of round.findings ?? []) {
        const body = clipUtf8StringToMaxBytes((f.body ?? '').trim(), MAX_FINDING_BYTES);
        lines.push(`    ${f.filePath} ${formatAnchor(f)}: ${body.replace(/\n+/g, ' ')}`);
      }
    }
    parts.push(lines.join('\n'));
  }

  return clipUtf8StringToMaxBytes(parts.join('\n\n'), MAX_INPUT_BYTES);
}

function sanitizeProse(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeChecklist(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    // Strip any markdown list / checkbox marker the model added anyway.
    let step = entry
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\[[ xX]\]\s*/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!step) continue;
    if (step.length > MAX_MANUAL_TESTING_STEP_LEN) {
      step = `${step.slice(0, MAX_MANUAL_TESTING_STEP_LEN - 1).trimEnd()}…`;
    }
    const key = step.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Tolerant JSON extraction: the model may wrap the object in a ```json fence or
 * add stray prose. Pull the first balanced `{...}` and parse it. Returns null
 * when nothing usable can be recovered — an object where every field came back
 * empty is treated as no answer at all.
 */
export function parseRunSummaryResponse(text: string): FinalizeRunSummaryNarrative | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const summary = sanitizeProse(obj.summary);
  const reviewNotes = sanitizeProse(obj.reviewNotes);
  const manualTesting = sanitizeChecklist(obj.manualTesting, MAX_MANUAL_TESTING_STEPS);
  const followUps = sanitizeChecklist(obj.followUps, MAX_FOLLOW_UP_STEPS);
  if (!summary && !reviewNotes && manualTesting.length === 0 && followUps.length === 0) {
    return null;
  }
  return { summary, reviewNotes, manualTesting, followUps };
}

/**
 * Ask a fast LLM for the narrative half of the run summary. Returns `null` when
 * no API key is configured, the call fails, times out, or the response is
 * malformed. Never throws.
 */
export async function generateFinalizeRunSummary(
  opts: FinalizeRunSummaryLlmOptions,
): Promise<FinalizeRunSummaryNarrative | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  if (!opts.openaiApiKey) return null;

  const input = buildRunSummaryInput(opts);
  if (!input.trim()) return null;

  const timeoutMs = Math.max(500, opts.timeoutMs ?? 15_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const model = opts.openaiModel || DEFAULT_TITLE_OPENAI_MODEL;
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${opts.openaiApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RUN_SUMMARY_PROMPT },
          { role: 'user', content: input },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content ?? '';
    return parseRunSummaryResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
