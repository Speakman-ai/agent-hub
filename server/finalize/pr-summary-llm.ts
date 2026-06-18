/**
 * pr-summary-llm.ts — LLM-backed PR title + summary generation.
 *
 * The deterministic builder in `buildPrDetails` names a multi-commit PR after
 * the kanban card title and uses the card description (or, failing that, the
 * card title) as the Summary. When the card title is itself vague or truncated
 * (e.g. an auto-generated session name like "Improving Ongoing Support and
 * Feature Implementation in") the resulting PR reads as nonsense even though
 * the commits clearly describe real work. The reverse failure also happens on
 * a single-commit branch: the PR is named after the last commit, capturing
 * only the final turn instead of the whole session.
 *
 * This module feeds the FULL set of commits (subjects + bodies) and the diff
 * stat to a fast LLM and asks for a coherent title + summary that captures the
 * entire change. It mirrors `generateLlmTitle` in session-title.ts: fetch-based
 * (no SDK), key-gated, time-boxed, and it NEVER throws — it returns `null` on
 * any failure so callers fall back to the deterministic builder.
 */

import { clipUtf8StringToMaxBytes } from '../utf8-clip.js';
import { DEFAULT_TITLE_ANTHROPIC_MODEL, DEFAULT_TITLE_OPENAI_MODEL } from '../session-title.js';

/** Hard cap on the synthesized PR title (GitHub renders ~70 well). */
const MAX_PR_TITLE_LEN = 70;
/** Total byte budget for the commits + diff stat fed to the model. */
const MAX_INPUT_BYTES = 8_000;
/** Per-commit body byte budget so one chatty commit can't crowd out the rest. */
const MAX_COMMIT_BODY_BYTES = 1_000;

export interface PrSummaryCommit {
  subject: string;
  body?: string;
}

export interface LlmPrSummaryOptions {
  /** Kanban card title — the session's stated goal. */
  cardTitle?: string | null;
  /** Kanban card description — what was originally asked. */
  cardDescription?: string | null;
  /** Commits on the branch, newest first (as collected by `collectPrCommits`). */
  commits: readonly PrSummaryCommit[];
  /** Output of `git diff --stat base...HEAD`. */
  diffStat?: string | null;
  /** Anthropic API key. If set, Anthropic wins over OpenAI. */
  anthropicApiKey?: string | null;
  /** OpenAI API key. Used when no Anthropic key is set. */
  openaiApiKey?: string | null;
  /** Override the Anthropic model. Defaults to `DEFAULT_TITLE_ANTHROPIC_MODEL`. */
  anthropicModel?: string;
  /** Override the OpenAI model. Defaults to `DEFAULT_TITLE_OPENAI_MODEL`. */
  openaiModel?: string;
  /** Abort after this many ms. Default: 12000. */
  timeoutMs?: number;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface LlmPrSummary {
  /** A concise PR title (<= 70 chars) describing the whole change. */
  title: string;
  /** 1–4 sentence summary of the entire PR. May contain markdown. */
  summary: string;
}

const PR_SUMMARY_PROMPT = [
  'You write pull-request titles and summaries for a software team.',
  'You are given every commit on a branch (newest first, subject + body), the',
  'changed-files stat, and the originating task. Synthesize the WHOLE change —',
  'not just the newest commit and not a restatement of the task title.',
  '',
  'Respond with ONLY a JSON object, no prose, no code fence:',
  '{"title": string, "summary": string}',
  '',
  'Rules:',
  '- title: <= 70 characters, imperative or noun-phrase, no trailing period,',
  '  no surrounding quotes. Name what the PR accomplishes overall.',
  '- summary: 1 to 4 sentences in plain prose describing what changed and why,',
  '  covering the through-line across all commits. No bullet list, no headings.',
  '- Prefer concrete specifics from the commits/diff over the (often vague)',
  '  task title. If the task title is generic, ignore it.',
  '- Do not invent changes that are not evidenced by the commits or diff.',
].join('\n');

/** Build the user-content blob: task context + commits + diff stat, byte-clipped. */
export function buildPrSummaryInput(opts: LlmPrSummaryOptions): string {
  const parts: string[] = [];
  const cardTitle = (opts.cardTitle ?? '').replace(/\s+/g, ' ').trim();
  const cardDescription = (opts.cardDescription ?? '').trim();
  if (cardTitle) parts.push(`Task title: ${cardTitle}`);
  if (cardDescription) {
    parts.push(`Task description:\n${clipUtf8StringToMaxBytes(cardDescription, 2_000)}`);
  }

  const commits = (opts.commits ?? []).filter(
    (c): c is PrSummaryCommit =>
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
  if (diffStat) parts.push(`Changed files:\n${clipUtf8StringToMaxBytes(diffStat, 2_000)}`);

  return clipUtf8StringToMaxBytes(parts.join('\n\n'), MAX_INPUT_BYTES);
}

function sanitizeSummaryTitle(raw: string): string {
  let t = (raw ?? '').trim();
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/[.,;:]+$/, '').trim();
  if (t.length > MAX_PR_TITLE_LEN) {
    const clipped = t.slice(0, MAX_PR_TITLE_LEN - 1);
    const lastSpace = clipped.lastIndexOf(' ');
    const cut =
      lastSpace > Math.floor(MAX_PR_TITLE_LEN * 0.6) ? clipped.slice(0, lastSpace) : clipped;
    t = `${cut.replace(/[.,;:\s]+$/, '')}…`;
  }
  return t;
}

function sanitizeSummaryBody(raw: string): string {
  return (raw ?? '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Tolerant JSON extraction: the model may wrap the object in a ```json fence or
 * add stray prose. Pull the first balanced `{...}` and parse it. Returns null
 * when no usable `{title, summary}` can be recovered.
 */
export function parsePrSummaryResponse(text: string): LlmPrSummary | null {
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
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { title?: unknown; summary?: unknown };
  const title = sanitizeSummaryTitle(typeof obj.title === 'string' ? obj.title : '');
  const summary = sanitizeSummaryBody(typeof obj.summary === 'string' ? obj.summary : '');
  // A title alone is enough to improve a vague PR; an empty title is not.
  if (!title) return null;
  return { title, summary };
}

/**
 * Ask a fast LLM to produce a PR title + summary from the full branch context.
 * Returns `null` when no API key is configured, the call fails, times out, or
 * the response is malformed. Never throws.
 */
export async function generateLlmPrSummary(
  opts: LlmPrSummaryOptions,
): Promise<LlmPrSummary | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  if (!opts.anthropicApiKey && !opts.openaiApiKey) return null;

  const input = buildPrSummaryInput(opts);
  if (!input.trim()) return null;

  const timeoutMs = Math.max(500, opts.timeoutMs ?? 12_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (opts.anthropicApiKey) {
      const model = opts.anthropicModel || DEFAULT_TITLE_ANTHROPIC_MODEL;
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': opts.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          system: PR_SUMMARY_PROMPT,
          messages: [{ role: 'user', content: input }],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
      return parsePrSummaryResponse(text);
    }
    if (opts.openaiApiKey) {
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
          max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PR_SUMMARY_PROMPT },
            { role: 'user', content: input },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      return parsePrSummaryResponse(text);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
