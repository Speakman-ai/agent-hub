/**
 * Helpers for passing oversized prompts to spawned CLI children without
 * tripping the Linux kernel's `MAX_ARG_STRLEN` cap (= `PAGE_SIZE * 32` =
 * 131072 bytes on x86_64). That cap applies per **single argv element**,
 * not to the total argv+env size — so a 200KB enriched system prompt
 * passed as a single `--system-prompt <value>` pair triggers `spawn
 * E2BIG` regardless of how small everything else is.
 *
 * Strategy by engine (see `chat.ts` for the wiring):
 *
 *   • claude-code  — uses `--system-prompt-file <path>` (documented
 *                    upstream flag). We write the enriched prompt to a
 *                    per-spawn temp file and the CLI reads it from disk.
 *   • codex-cli    — uses the `-` stdin sentinel (`codex exec -`). The
 *                    full combined prompt is piped via the child's stdin
 *                    and the positional argv carries only the sentinel.
 *   • cursor-agent — no `--system-prompt-file`, no stdin, and no per-invocation
 *                    rules flag (rules only load from `.cursor/rules` in cwd).
 *                    We write Hub rules to a *per-session* always-apply file,
 *                    `.cursor/rules/agent-hub.session-<id>.mdc`, whose
 *                    collision-resistant name cannot overwrite a repo-owned or
 *                    another session's file, and `-p` carries only the user
 *                    turn. The full rule payload lives on disk, so the argv cap
 *                    never trims it; the file is git-excluded and removed on
 *                    process close. Only a genuine write failure (symlink
 *                    attack / IO error) falls back to inlining into `-p`.
 *   • gemini-cli   — no `--system-prompt-file`, and `GEMINI_SYSTEM_MD` *fully
 *                    replaces* Gemini's built-in core system prompt (safety,
 *                    tool-operation, approval, reliability) with no token to
 *                    restore it. So we do NOT override it: the Hub rules ride
 *                    on **stdin** (unbounded — the kernel argv cap applies to
 *                    argv elements, not stdin), which the CLI prepends to the
 *                    `-p` user turn. This preserves the entire core prompt and
 *                    the argv cap can never trim the Hub payload.
 *
 * The 100 KB soft cap is well below the kernel's 128 KiB hard ceiling
 * but leaves ~28 KB of headroom for any flags Claude/Codex still pass
 * inline (engine-session-id, model, config paths, etc.). It is not
 * a hard wall on the agent's behalf — it's a defense against the cliff.
 */

import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { registerCursorRuleFile } from './cursor-rule-registry.js';

/** Workspace-relative directory Cursor loads always-apply project rules from. */
export const CURSOR_HUB_RULES_DIR = '.cursor/rules';

/**
 * Gitignore-style glob covering every Hub-written Cursor session rule. Used for
 * the local `.git/info/exclude` entry so no session's rule can be committed or
 * show up as an untracked change, regardless of its session id.
 */
export const CURSOR_HUB_SESSION_RULE_GLOB = `${CURSOR_HUB_RULES_DIR}/agent-hub.session-*.mdc`;

/**
 * Collision-resistant, per-session path for the Cursor always-apply rule. The
 * session id is baked into the filename so the Hub write can never overwrite a
 * repository-owned file at a fixed path, nor clobber another concurrent
 * session's rule — the reviewer-requested out-of-band delivery that keeps the
 * complete Hub payload on disk (never trimmed by the argv cap) even in a shared
 * project directory.
 */
export function cursorHubSessionRuleRelPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
  return `${CURSOR_HUB_RULES_DIR}/agent-hub.session-${safe}.mdc`;
}

/**
 * Linux kernel cap on a single argv element. Set to `PAGE_SIZE * 32`
 * in `fs/exec.c`. On all of Agent Hub's target hosts (x86_64 / arm64
 * with 4 KiB pages) this is exactly 131072 bytes. This is the value
 * that produces `spawn E2BIG` when exceeded.
 */
export const MAX_ARG_STRLEN_BYTES = 131072;

/**
 * Soft cap we enforce ourselves. Picked so that:
 *   • Other argv flags (model id, config path, session id) fit
 *     comfortably below the kernel ceiling even after concatenation
 *     with the prompt.
 *   • There's enough margin that the prompt builder can grow modestly
 *     (one more skill loaded, a slightly chattier daily note) without
 *     immediately re-tripping the cliff.
 *
 * If a future engine grows argv-flags that approach this margin, lower
 * the cap rather than raise it — the kernel limit is non-negotiable.
 */
export const SAFE_ARG_STRLEN_BYTES = 100_000;

/**
 * Write the enriched system prompt to a per-spawn temp file. Used by
 * the claude-code branch in `chat.ts` to pass `--system-prompt-file
 * <path>` instead of `--system-prompt <huge string>`.
 *
 * Returns the absolute path and a `cleanup()` thunk. The caller is
 * responsible for invoking `cleanup()` after the child exits — typically
 * from the `proc.on('close')` handler. Best-effort: rm failures are
 * swallowed so a stray temp file never breaks a turn.
 */
export function writeSystemPromptFile(
  enrichedPrompt: string,
  sessionId: string,
): { path: string; cleanup: () => void } {
  // mkdtempSync gives us a unique per-spawn directory. We put a single
  // file in it so the cleanup can be a simple recursive rm without
  // worrying about other tenants of `tmpdir()`.
  const dir = mkdtempSync(path.join(os.tmpdir(), `agent-hub-prompt-${sessionId.slice(0, 8)}-`));
  const filePath = path.join(dir, 'system-prompt.md');
  writeFileSync(filePath, enrichedPrompt, { encoding: 'utf8', mode: 0o600 });
  return {
    path: filePath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Marker embedded in every Hub-written Cursor rule. Lets us recognize our own
 * managed file so a later spawn overwrites the Hub file it wrote but refuses to
 * clobber a user's / repo's own file that happens to sit at the same path.
 * Rendered as a markdown comment so Cursor ignores it.
 */
export const CURSOR_HUB_RULE_MARKER = '<!-- agent-hub:session-rule managed; do not edit -->';

/**
 * Format Hub session instructions as a Cursor project rule that always
 * attaches. `alwaysApply: true` with no globs/description is the "Always
 * Apply" mode the CLI honors in headless `-p` / `--print` runs.
 */
export function formatCursorHubSessionRule(body: string): string {
  return `---\nalwaysApply: true\n---\n${CURSOR_HUB_RULE_MARKER}\n\n${body.replace(/\s+$/, '')}\n`;
}

/**
 * Resolve the common git dir for a per-worktree gitdir. A linked worktree's
 * gitdir (`<common>/.git/worktrees/<name>`) carries a `commondir` pointer file
 * (usually `../..`) back to the shared `<common>/.git`. `info/exclude` lives in
 * that common dir, not the per-worktree one — mirroring
 * `git rev-parse --git-path info/exclude` without shelling out to git.
 */
function resolveGitCommonDir(gitDir: string): string {
  try {
    const commonDirFile = path.join(gitDir, 'commondir');
    if (existsSync(commonDirFile)) {
      const rel = readFileSync(commonDirFile, 'utf8').trim();
      if (rel) return path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
    }
  } catch {
    /* best-effort — fall back to the gitdir itself */
  }
  return gitDir;
}

/**
 * Resolve `.git/info/exclude` for a worktree or plain clone. Returns
 * null when `cwd` is not a git checkout. Best-effort; never throws.
 *
 * For a linked worktree `.git` is an indirection file pointing at the
 * per-worktree gitdir, but Git reads `info/exclude` from the *common* git dir.
 * We follow `commondir` so the Hub-owned rule is excluded where Git actually
 * looks, instead of a per-worktree path Git never reads.
 */
export function resolveGitInfoExcludePath(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, '.git');
    if (!existsSync(gitPath)) return null;
    const st = statSync(gitPath);
    if (st.isDirectory()) return path.join(gitPath, 'info', 'exclude');
    const text = readFileSync(gitPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match?.[1]) return null;
    const gitDir = match[1].trim();
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    return path.join(resolveGitCommonDir(absGitDir), 'info', 'exclude');
  } catch {
    return null;
  }
}

/**
 * Append `relPath` to the repo's local `.git/info/exclude` if missing.
 * Best-effort: a missing repo or permissions error is ignored so a
 * spawn never fails because we couldn't hide a Hub-owned file.
 */
export function appendLocalGitExclude(cwd: string, relPath: string): void {
  const excludePath = resolveGitInfoExcludePath(cwd);
  if (!excludePath) return;
  try {
    mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    if (lines.includes(relPath)) return;
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(excludePath, `${existing}${sep}${relPath}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * True when the deepest existing ancestor of `abs` canonicalizes to a location
 * inside `cwd`. Guards against a tracked `.cursor` / `rules` symlink redirecting
 * the write outside the worktree: we realpath the nearest existing directory in
 * the chain and confirm containment before creating the rest.
 */
function writeTargetStaysInsideCwd(cwd: string, abs: string): boolean {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return false;
  }
  let ancestor = path.dirname(abs);
  while (!existsSync(ancestor)) {
    const up = path.dirname(ancestor);
    if (up === ancestor) break;
    ancestor = up;
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(ancestor);
  } catch {
    return false;
  }
  const rel = path.relative(realCwd, realAncestor);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Best-effort removal of a session's Cursor rule file. Never follows a symlink
 * at the final component (unlinks the link, not its target) and never throws —
 * cleanup must never break a turn teardown.
 */
export function removeCursorHubSessionRuleFile(abs: string): void {
  try {
    // rmSync unlinks the path itself; for a symlink it removes the link, not
    // whatever it points at. force:true swallows ENOENT (already gone).
    rmSync(abs, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Write Hub rules into the spawn cwd as a Cursor always-apply rule so the CLI
 * loads the *complete* payload from disk instead of an argv element the kernel
 * cap could trim. The filename is per-session
 * (`.cursor/rules/agent-hub.session-<id>.mdc`), which makes it collision
 * resistant: it can never overwrite a repository-owned file at a fixed path nor
 * another concurrent session's rule. The file is git-excluded (so it can't be
 * committed or surface as an untracked change) and the returned `cleanup()`
 * removes it on process close, so it does not linger to pollute unrelated
 * Cursor chats. Callers write it before every turn and invoke `cleanup()` from
 * the spawn's close handler.
 *
 * This is written for EVERY cwd, including shared / real project directories —
 * a shared-cwd session is a supported execution shape and still needs the full
 * (untrimmed) rules. To keep that safe without relying only on best-effort
 * close cleanup, each written path is recorded in a Hub-owned manifest
 * (`registerCursorRuleFile`) that the server sweeps at startup
 * (`sweepOrphanedCursorRuleFiles`), so a file a crashed process left behind is
 * deterministically removed on the next boot and can never persist to
 * contaminate later unrelated Cursor sessions. Between turns the close handler
 * removes it, so its normal footprint is a single active turn.
 *
 * Refuses (returns null, logs, never throws) for a genuine write hazard, so the
 * caller can fall back to inlining into `-p`:
 *   • a tracked `.cursor` / `rules` symlink would redirect the write outside
 *     the cwd,
 *   • the target itself is a symlink (writing would follow it and overwrite
 *     whatever it points at),
 *   • a pre-existing regular file at the path is *not* a Hub-managed rule, or
 *   • the write throws (permissions / IO).
 */
export function writeCursorHubSessionRule(
  cwd: string,
  body: string,
  sessionId: string,
): { path: string; cleanup: () => void } | null {
  const relPath = cursorHubSessionRuleRelPath(sessionId);
  const abs = path.join(cwd, relPath);
  if (!writeTargetStaysInsideCwd(cwd, abs)) {
    console.warn(`[spawn] Refusing to write Cursor Hub rule: path escapes cwd (${abs})`);
    return null;
  }
  try {
    // lstat (not stat) so a symlinked final component is caught instead of
    // followed. ENOENT is the normal "create it" path.
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      console.warn(`[spawn] Refusing to write Cursor Hub rule: ${abs} is a symlink`);
      return null;
    }
    if (lst.isDirectory()) {
      console.warn(`[spawn] Refusing to write Cursor Hub rule: ${abs} is a directory`);
      return null;
    }
    if (lst.isFile()) {
      const existing = readFileSync(abs, 'utf8');
      if (!existing.includes(CURSOR_HUB_RULE_MARKER)) {
        console.warn(`[spawn] Refusing to overwrite non-Hub Cursor rule at ${abs}`);
        return null;
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[spawn] Refusing to write Cursor Hub rule: cannot stat ${abs}`);
      return null;
    }
  }
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, formatCursorHubSessionRule(body), { encoding: 'utf8', mode: 0o600 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn] Failed to write Cursor Hub rule at ${abs}: ${message}`);
    return null;
  }
  appendLocalGitExclude(cwd, CURSOR_HUB_SESSION_RULE_GLOB);
  // Record for the crash-safe startup sweep so a missed close cleanup (crash /
  // SIGKILL) can never leave this file behind in a shared/real repo.
  registerCursorRuleFile(abs);
  return { path: abs, cleanup: () => removeCursorHubSessionRuleFile(abs) };
}

/**
 * Soft truncation guard for engines that still pass a prompt as a single
 * argv element (oversized *user* messages, grok-cli, or a cwd-less
 * cursor/gemini fallback). Returns the prompt unchanged when below
 * the cap; otherwise trims the prefix from the front (preserving
 * the user-facing tail / final prompt) and returns the trimmed result
 * with a `truncated` signal so the caller can emit `TOOL_ERROR`.
 *
 * The semantics are deliberately simple: we keep the last
 * `SAFE_ARG_STRLEN_BYTES` of the combined prompt and prefix a single
 * marker line so the agent (and any reviewer looking at the transcript)
 * knows truncation happened. We do not attempt to surgically excise
 * specific sections of the enriched prompt — that's the lazy-load
 * follow-up (option 2) tracked separately.
 *
 * @returns `{ prompt, truncated, originalBytes }` — when `truncated` is
 *          true the caller should also emit a structured `TOOL_ERROR`
 *          line so the growth pattern surfaces in session health.
 */
export function applyArgvPromptCap(
  prompt: string,
  cap: number = SAFE_ARG_STRLEN_BYTES,
): { prompt: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes <= cap) return { prompt, truncated: false, originalBytes: bytes };

  // Keep the tail: that's where the user's actual current-turn message
  // lives. Drop the head (enriched system prompt + retrieved context),
  // which is the unbounded part. Leave room for the marker prefix.
  const marker =
    `[NOTE: enriched system prompt truncated by ${bytes - cap}+ bytes to fit ` +
    `the engine's argv cap. See TOOL_ERROR log for details.]\n\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keepBytes = Math.max(0, cap - markerBytes);

  // Slice by characters rather than bytes; for ASCII-heavy prompts the
  // difference is negligible, and for multi-byte characters we err on
  // the side of keeping fewer bytes (= safer) than `cap`.
  const sliceStart = Math.max(0, prompt.length - keepBytes);
  const trimmed = marker + prompt.slice(sliceStart);
  return { prompt: trimmed, truncated: true, originalBytes: bytes };
}

/**
 * Emit a structured TOOL_ERROR line covering an argv-cap truncation
 * event. Centralized here so all three call sites (cursor, gemini, and
 * any future engine that lacks file/stdin support) log the same shape.
 *
 * The v2 JSON tail uses `sev: "soft"` because truncation does not block
 * the turn — the agent still runs, just with less context. Mining this
 * tag (`argv-cap`) over time tells us whether to invest in lazy-loading
 * skill references vs continuing to grow the inline prompt.
 */
export function logArgvCapTruncation(
  engine: string,
  sessionId: string,
  originalBytes: number,
  cap: number,
): void {
  const summary = `enriched prompt ${originalBytes}B > argv cap ${cap}B; trimmed to fit`;
  const meta = JSON.stringify({
    v: 2,
    sev: 'soft',
    resolution: 'recovered',
    session: sessionId,
    tags: ['argv-cap', 'spawn', engine],
  });
  console.error(
    `TOOL_ERROR | ${new Date().toISOString()} | spawn-prompt | argv-cap-trim | warn | ${summary} | ${meta}`,
  );
}

/**
 * Header the history-bootstrap prompt opens with. Kept as a constant so
 * tests and the budget accounting agree on the exact bytes.
 */
export const HISTORY_BOOTSTRAP_HEADER = 'Previous conversation:\n';

/**
 * Smallest slice of a single message worth inlining. Below this a partial
 * message is more confusing than helpful, so the message is dropped and
 * counted in the omission notice instead.
 */
const MIN_MESSAGE_KEEP_BYTES = 2_000;

/** Fraction of a middle-truncated message's budget spent on its head. */
const MIDDLE_TRUNCATE_HEAD_RATIO = 0.4;

export interface HistoryBootstrapMessage {
  role: string;
  content: string;
}

export interface HistoryBootstrapResult {
  /**
   * Prompt to hand the engine, within `cap` — with exactly one exception:
   * when `currentTurn` alone exceeds `cap` the turn is passed through
   * untrimmed, because dropping the user's actual question is worse than
   * overshooting a soft cap the engine branch trims again.
   */
  prompt: string;
  /** True when any history content was elided to fit. */
  truncated: boolean;
  /** Prior messages left out entirely (oldest-first). */
  omittedMessages: number;
  /** Byte size of the untruncated prompt, for logging. */
  originalBytes: number;
}

function historyRoleLabel(role: string): string {
  return role === 'user' ? 'Human' : 'Assistant';
}

function renderHistoryBlock(m: HistoryBootstrapMessage): string {
  return `${historyRoleLabel(m.role)}: ${m.content}\n\n`;
}

function renderOmissionNotice(count: number): string {
  return (
    `[NOTE: ${count} earlier message${count === 1 ? '' : 's'} omitted — this conversation ` +
    `exceeded the engine's prompt budget. Ask the user for anything you need from the ` +
    `missing history rather than assuming it was never said.]\n\n`
  );
}

/**
 * Smallest prompt that still carries the current turn.
 *
 * Keeps the header and the omission notice when they fit inside `cap` so the
 * agent still learns that history was dropped; falls back to the bare current
 * turn when even that framing would overflow. Returns something larger than
 * `cap` only when `currentTurn` alone already exceeds it — the current turn is
 * never trimmed here, because losing the user's actual question is worse than
 * overshooting a soft cap the engine branch trims again.
 */
function currentTurnOnlyPrompt(currentTurn: string, omittedMessages: number, cap: number): string {
  const framed =
    HISTORY_BOOTSTRAP_HEADER + renderOmissionNotice(omittedMessages) + `Human: ${currentTurn}`;
  return Buffer.byteLength(framed, 'utf8') <= cap ? framed : currentTurn;
}

/**
 * Keep the head and the tail of an oversized message, eliding the middle.
 *
 * Head-and-tail rather than tail-only because a forwarded transcript puts
 * the forwarder's own instructions and the provenance marker at the very
 * top — dropping those is what makes an agent look like it ignored the
 * forward entirely.
 */
function truncateMessageMiddle(text: string, budget: number): string {
  let headChars = Math.floor(budget * MIDDLE_TRUNCATE_HEAD_RATIO);
  let tailChars = Math.floor(budget * (1 - MIDDLE_TRUNCATE_HEAD_RATIO));
  // Budget is bytes, the slices are characters; shrink until multi-byte
  // content stops overshooting.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (headChars + tailChars >= text.length) return text;
    const omitted = text.length - headChars - tailChars;
    const marker = `\n\n[... ${omitted} characters omitted from the middle of this message ...]\n\n`;
    const out = text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
    if (Buffer.byteLength(out, 'utf8') <= budget) return out;
    headChars = Math.floor(headChars * 0.85);
    tailChars = Math.floor(tailChars * 0.85);
  }
  return '';
}

/**
 * Build the "history bootstrap" prompt sent on the first turn of a session
 * that already has stored messages but no engine session id yet (a forwarded
 * session, a pre-seeded card session, a session whose resume id was cleared).
 *
 * The current turn is never sacrificed; history is filled in newest-first up
 * to `cap`, and anything that doesn't fit is elided with a marker the agent
 * can see. Silently returning the current turn alone — the previous behavior —
 * meant a forwarded session's entire context vanished with no signal to the
 * user or the agent.
 */
export function buildHistoryBootstrapPrompt(
  priorMessages: HistoryBootstrapMessage[],
  currentTurn: string,
  cap: number = SAFE_ARG_STRLEN_BYTES,
): HistoryBootstrapResult {
  if (priorMessages.length === 0) {
    return {
      prompt: currentTurn,
      truncated: false,
      omittedMessages: 0,
      originalBytes: Buffer.byteLength(currentTurn, 'utf8'),
    };
  }

  const turnBlock = `Human: ${currentTurn}`;
  const blocks = priorMessages.map(renderHistoryBlock);
  const full = HISTORY_BOOTSTRAP_HEADER + blocks.join('') + turnBlock;
  const originalBytes = Buffer.byteLength(full, 'utf8');
  if (originalBytes <= cap) {
    return { prompt: full, truncated: false, omittedMessages: 0, originalBytes };
  }

  const reserved = Buffer.byteLength(
    HISTORY_BOOTSTRAP_HEADER + renderOmissionNotice(priorMessages.length) + turnBlock,
    'utf8',
  );
  let budget = cap - reserved;
  if (budget < MIN_MESSAGE_KEEP_BYTES) {
    // The current turn plus the framing already eats the budget — there is no
    // room left for a history slice worth reading.
    return {
      prompt: currentTurnOnlyPrompt(currentTurn, priorMessages.length, cap),
      truncated: true,
      omittedMessages: priorMessages.length,
      originalBytes,
    };
  }

  const kept: string[] = [];
  let omittedMessages = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (blockBytes <= budget) {
      kept.unshift(block);
      budget -= blockBytes;
      continue;
    }
    const partial = budget >= MIN_MESSAGE_KEEP_BYTES ? truncateMessageMiddle(block, budget) : '';
    if (partial) {
      kept.unshift(partial);
      omittedMessages = i;
    } else {
      omittedMessages = i + 1;
    }
    break;
  }

  const notice = omittedMessages > 0 ? renderOmissionNotice(omittedMessages) : '';
  const prompt = HISTORY_BOOTSTRAP_HEADER + notice + kept.join('') + turnBlock;
  if (Buffer.byteLength(prompt, 'utf8') <= cap) {
    return { prompt, truncated: true, omittedMessages, originalBytes };
  }
  // Defensive: the budget accounting above should keep us under `cap`. If a
  // future edit breaks that, drop the history rather than hand the engine an
  // oversized argv element.
  return {
    prompt: currentTurnOnlyPrompt(currentTurn, priorMessages.length, cap),
    truncated: true,
    omittedMessages: priorMessages.length,
    originalBytes,
  };
}

/**
 * Test-only helper for callers that need a deterministic temp root.
 * Returns the parent dir we'll create per-spawn subdirs under. Kept
 * here so tests don't have to second-guess the `os.tmpdir()` location.
 */
export function _getPromptTmpRoot(): string {
  const root = os.tmpdir();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* tmpdir always exists */
  }
  return root;
}
