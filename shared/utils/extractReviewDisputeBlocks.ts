/**
 * `<agenthub:review-dispute>` — an implementer's pushback on Finalize review
 * findings, emitted at the end of a fix turn (see
 * `server/finalize/review-dispute.ts` for the server-side contract).
 *
 * The server reads the block from the stored turn text; the chat surfaces use
 * this helper to pull it out of the prose and show it as a card. Left in the
 * prose, react-markdown autolinks the opening tag and dumps the JSON wall.
 *
 * An opening tag with no closer (a turn still streaming) is cut from the
 * prose to the end, so the JSON never flashes in while it arrives.
 */
import { closeTagPatternSource, openTagPatternSource } from './controlTagPattern.js';

const TAG = 'agenthub:review-dispute';
const REASON_LIMIT = 4_000;
const MAX_DISPUTES = 50;

export interface ExtractedReviewDispute {
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  reason: string;
}

export interface ExtractedReviewDisputeBlock {
  disputes: ExtractedReviewDispute[];
  /** Raw body, kept so an unparseable block still shows what the agent said. */
  raw: string;
  /** True while the closing tag has not arrived yet. */
  partial: boolean;
}

function coerceLine(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function parseBody(raw: string): ExtractedReviewDispute[] {
  let body = raw.trim();
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(body);
  if (fence) body = fence[2].trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).disputes
      : null;
  if (!Array.isArray(list)) return [];
  const out: ExtractedReviewDispute[] = [];
  for (const item of list.slice(0, MAX_DISPUTES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    const filePath = typeof d.file_path === 'string' ? d.file_path.trim() : '';
    const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
    if (!filePath || !reason) continue;
    const lineStart = coerceLine(d.line_start);
    out.push({
      filePath,
      lineStart,
      lineEnd: coerceLine(d.line_end ?? d.line_start) ?? lineStart,
      reason: reason.slice(0, REASON_LIMIT),
    });
  }
  return out;
}

export function extractReviewDisputeBlocks(text: string | null | undefined): {
  strippedText: string;
  blocks: ExtractedReviewDisputeBlock[];
} {
  if (typeof text !== 'string' || !text.includes(`<${TAG}>`)) {
    return { strippedText: typeof text === 'string' ? text : '', blocks: [] };
  }
  const open = openTagPatternSource(TAG);
  const close = closeTagPatternSource(TAG);
  const blocks: ExtractedReviewDisputeBlock[] = [];
  const take = (body: string, partial: boolean) => {
    blocks.push({ disputes: parseBody(body), raw: body.trim(), partial });
    return '';
  };
  let result = text;
  // A fence the model wrapped around the whole tag goes with it.
  for (const f of ['```', '~~~']) {
    result = result.replace(
      new RegExp(
        `${f}[^\\n${f[0]}]*\\r?\\n[ \\t]*${open}([\\s\\S]*?)${close}[ \\t]*\\r?\\n[ \\t]*${f}`,
        'gi',
      ),
      (_m, body: string) => take(body, false),
    );
  }
  result = result.replace(new RegExp(`${open}([\\s\\S]*?)${close}`, 'gi'), (_m, body: string) =>
    take(body, false),
  );
  result = result.replace(new RegExp(`${open}([\\s\\S]*)$`, 'i'), (_m, body: string) =>
    take(body, true),
  );
  return { strippedText: result.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

/** `path:12-15`, `path:12`, or `path` for a file-level dispute. */
export function formatReviewDisputeLocation(d: ExtractedReviewDispute): string {
  if (d.lineStart == null) return d.filePath;
  if (d.lineEnd == null || d.lineEnd === d.lineStart) return `${d.filePath}:${d.lineStart}`;
  return `${d.filePath}:${d.lineStart}-${d.lineEnd}`;
}
