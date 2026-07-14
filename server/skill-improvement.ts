import path from 'path';
import { randomUUID } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { isSkillAllowed } from './agent-skills-list.js';
import { loadSkillBody, type SkillInvokePaths } from './skill-invoke.js';
import {
  detectTagBlockInLastFence,
  extractJsonFromTagBody,
  stripFencedCodeBlockBodies,
} from './action-block-parsing.js';

export const SKILL_IMPROVEMENT_TAG = 'agenthub:skill-improvement';
export const SKILL_IMPROVEMENT_SECTION = 'Learned Lessons';
export const SKILL_IMPROVEMENT_PENDING_DIR = '.agenthub';
export const SKILL_IMPROVEMENT_PENDING_FILE = 'pending-skill-improvements.jsonl';
const MAX_ENTRY_CHARS = 1200;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export interface SkillImprovementTask {
  name: string;
  entry: string;
}

export type SkillImprovementStatus = 'pending' | 'approved' | 'rejected';

export interface SkillImprovementRecord {
  id: string;
  skillId: string;
  source: 'project' | 'global';
  entry: string;
  status: SkillImprovementStatus;
  createdAt: string;
  /** Session that suggested the lesson — the provenance link reviewers use. */
  sessionId?: string | null;
  /** Agent that suggested the lesson. */
  agentId?: string | null;
  /** Set when the record leaves `pending` (approve or reject). */
  reviewedAt?: string | null;
  /** Optional reviewer-supplied reason, kept for audit (reject only). */
  rejectReason?: string | null;
}

/** @deprecated Alias kept for callers written against the capture-only phase. */
export type PendingSkillImprovementRecord = SkillImprovementRecord;

export interface SkillImprovementMalformed {
  error: 'malformed';
  detail: string;
}

export interface HandleSkillImprovementArgs {
  rawBlock: string;
  paths: SkillInvokePaths;
  allowedSkills?: string[] | null;
  loadedSkillIds: Iterable<string>;
  /**
   * Where the suggestion came from. Stored on the pending record so reviewers
   * can jump to the originating session transcript — the affordance that lets
   * a human distinguish a legitimate lesson from injected instructions the
   * agent merely *read* during the session.
   */
  provenance?: { sessionId?: string | null; agentId?: string | null };
}

export interface HandleSkillImprovementResult {
  ok: boolean;
  markdown: string;
  observation: string;
  /** Set on success so callers can broadcast/report the stored record. */
  record?: SkillImprovementRecord;
}

export function detectSkillImprovementBlock(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const scanned = stripFencedCodeBlockBodies(text);
  const re = new RegExp(
    `<${SKILL_IMPROVEMENT_TAG}>\\s*[\\s\\S]*?\\s*</${SKILL_IMPROVEMENT_TAG}>`,
    'gi',
  );
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(scanned)) !== null) {
    last = match[0];
  }
  if (last) {
    let originalLast: string | null = null;
    while ((match = re.exec(text)) !== null) {
      originalLast = match[0];
    }
    return originalLast ?? last;
  }
  return detectTagBlockInLastFence(text, SKILL_IMPROVEMENT_TAG);
}

function normalizeEntry(raw: string): string {
  return raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withSkillFileLock<T>(skillMdPath: string, fn: () => T): T {
  const lockDir = `${skillMdPath}.agenthub-lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > STALE_LOCK_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for skill improvement lock: ${lockDir}`);
      }
      sleepSync(50);
    }
  }
}

function loadedSkillIdsContain(loadedSkillIds: Iterable<string>, skillName: string): boolean {
  for (const loadedSkillId of loadedSkillIds) {
    if (loadedSkillId === skillName) return true;
  }
  return false;
}

function writableSkillBaseDir(skillDirOrMdPath: string, isFlatMarkdownSkill: boolean): string {
  return isFlatMarkdownSkill ? path.dirname(skillDirOrMdPath) : skillDirOrMdPath;
}

export function pendingSkillImprovementStorePath(
  skillDirOrMdPath: string,
  isFlatMarkdownSkill = false,
): string {
  return path.join(
    writableSkillBaseDir(skillDirOrMdPath, isFlatMarkdownSkill),
    SKILL_IMPROVEMENT_PENDING_DIR,
    SKILL_IMPROVEMENT_PENDING_FILE,
  );
}

function writePendingSkillImprovement(
  pendingStorePath: string,
  record: SkillImprovementRecord,
): void {
  mkdirSync(path.dirname(pendingStorePath), { recursive: true });
  withSkillFileLock(pendingStorePath, () => {
    appendFileSync(pendingStorePath, `${JSON.stringify(record)}\n`);
  });
}

/**
 * Read every improvement record in a skill's JSONL store (all statuses, in
 * append order). Malformed lines are skipped — the store is append-only and a
 * torn write must not make the whole queue unreadable.
 */
export function readSkillImprovements(pendingStorePath: string): SkillImprovementRecord[] {
  if (!existsSync(pendingStorePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(pendingStorePath, 'utf-8');
  } catch {
    return [];
  }
  const out: SkillImprovementRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (
        rec &&
        typeof rec === 'object' &&
        typeof (rec as SkillImprovementRecord).id === 'string' &&
        typeof (rec as SkillImprovementRecord).entry === 'string'
      ) {
        out.push(rec as SkillImprovementRecord);
      }
    } catch {
      /* skip torn/garbage line */
    }
  }
  return out;
}

export type ReviewSkillImprovementErrorCode =
  | 'skill_not_found'
  | 'default_readonly'
  | 'improvement_not_found'
  | 'already_reviewed'
  | 'io';

export type ReviewSkillImprovementResult =
  | { ok: true; record: SkillImprovementRecord; skillMdPath: string }
  | { ok: false; code: ReviewSkillImprovementErrorCode; error: string };

export interface ReviewSkillImprovementArgs {
  skillId: string;
  improvementId: string;
  action: 'approve' | 'reject';
  /** Optional reviewer note, persisted on reject for audit. */
  reason?: string;
  paths: SkillInvokePaths;
  now?: Date;
}

/**
 * Promote (approve) or discard (reject) one pending improvement.
 *
 * Approve appends the dated bullet to the skill's `## Learned Lessons`
 * section via {@link appendSkillLearning} and marks the JSONL record
 * `approved`; reject only marks the record. Both run inside the store's
 * file lock so concurrent reviews / capture appends serialize. The SKILL.md
 * body is re-read from disk here — `loadSkillBody` caps its copy at 32KB and
 * promoting through that copy would silently truncate a large skill.
 */
export function reviewSkillImprovement(
  args: ReviewSkillImprovementArgs,
): ReviewSkillImprovementResult {
  const loaded = loadSkillBody(args.skillId, args.paths);
  if (!loaded) {
    return {
      ok: false,
      code: 'skill_not_found',
      error: `Skill "${args.skillId}" was not found in project/global skill directories.`,
    };
  }
  if (loaded.source === 'default') {
    return {
      ok: false,
      code: 'default_readonly',
      error: `Skill "${args.skillId}" is a bundled default skill; its improvements are read-only.`,
    };
  }

  const isFlat = Boolean(loaded.skillTitle);
  const skillMdPath = isFlat ? loaded.skillDir : path.join(loaded.skillDir, 'SKILL.md');
  const pendingStorePath = pendingSkillImprovementStorePath(loaded.skillDir, isFlat);

  try {
    return withSkillFileLock(pendingStorePath, (): ReviewSkillImprovementResult => {
      const records = readSkillImprovements(pendingStorePath);
      const idx = records.findIndex((r) => r.id === args.improvementId);
      if (idx === -1) {
        return {
          ok: false,
          code: 'improvement_not_found',
          error: `Improvement "${args.improvementId}" was not found for skill "${args.skillId}".`,
        };
      }
      const record = records[idx]!;
      if (record.status !== 'pending') {
        return {
          ok: false,
          code: 'already_reviewed',
          error: `Improvement "${args.improvementId}" was already ${record.status}.`,
        };
      }

      if (args.action === 'approve') {
        const rawSkillMd = readFileSync(skillMdPath, 'utf-8');
        // Idempotence guard: SKILL.md is appended before the JSONL record is
        // rewritten, so a crash between the two writes leaves the record
        // `pending` with the bullet already on disk. A re-approve must then
        // only repair the record, not append a duplicate bullet.
        if (!skillMdContainsLearning(rawSkillMd, record.entry)) {
          writeFileSync(
            skillMdPath,
            appendSkillLearning(rawSkillMd, record.entry, { now: args.now }),
          );
        }
      }

      const reviewed: SkillImprovementRecord = {
        ...record,
        status: args.action === 'approve' ? 'approved' : 'rejected',
        reviewedAt: (args.now ?? new Date()).toISOString(),
        ...(args.action === 'reject' && args.reason?.trim()
          ? { rejectReason: args.reason.trim().slice(0, MAX_ENTRY_CHARS) }
          : {}),
      };
      records[idx] = reviewed;
      writeFileSync(pendingStorePath, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
      return { ok: true, record: reviewed, skillMdPath };
    });
  } catch (err) {
    return { ok: false, code: 'io', error: (err as Error).message };
  }
}

export function parseSkillImprovementBlock(
  raw: string,
): SkillImprovementTask | SkillImprovementMalformed {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'malformed', detail: 'Empty skill improvement block payload' };
  }

  const tagMatch = raw.match(
    new RegExp(`<${SKILL_IMPROVEMENT_TAG}>\\s*([\\s\\S]*?)\\s*</${SKILL_IMPROVEMENT_TAG}>`, 'i'),
  );
  const payload = (tagMatch ? tagMatch[1] : raw).trim();
  const normalized = extractJsonFromTagBody(payload);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(payload) : JSON.parse(normalized);
  } catch (err) {
    return { error: 'malformed', detail: `Invalid JSON: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'malformed', detail: 'Skill improvement payload must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { error: 'malformed', detail: 'Missing required string field: name' };
  }
  if (typeof obj.entry !== 'string' || !obj.entry.trim()) {
    return { error: 'malformed', detail: 'Missing required string field: entry' };
  }

  const name = obj.name.trim();
  if (name !== path.basename(name) || name.includes('\0')) {
    return { error: 'malformed', detail: 'Field "name" must be a skill id, not a path' };
  }

  const entry = normalizeEntry(obj.entry);
  if (!entry) return { error: 'malformed', detail: 'Field "entry" cannot be empty' };
  if (entry.length > MAX_ENTRY_CHARS) {
    return {
      error: 'malformed',
      detail: `Field "entry" must be <= ${MAX_ENTRY_CHARS} characters`,
    };
  }

  return { name, entry };
}

/**
 * True when `rawSkillMd` already carries `entry` as a dated Learned-Lessons
 * bullet (`- YYYY-MM-DD: <entry>`), regardless of the date. Makes approval
 * idempotent: if a previous approve appended the bullet but crashed before
 * marking the JSONL record reviewed, the retry must not append a duplicate.
 */
export function skillMdContainsLearning(rawSkillMd: string, entry: string): boolean {
  const normalized = normalizeEntry(entry);
  return rawSkillMd.split('\n').some((line) => {
    const m = line.match(/^- \d{4}-\d{2}-\d{2}: (.*)$/);
    return m !== null && m[1] === normalized;
  });
}

export function appendSkillLearning(
  rawSkillMd: string,
  entry: string,
  opts: { now?: Date } = {},
): string {
  const normalizedEntry = normalizeEntry(entry);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const bullet = `- ${date}: ${normalizedEntry}`;
  const trimmedEnd = rawSkillMd.replace(/\s+$/, '');
  const sectionRe = new RegExp(`(^|\\n)## ${SKILL_IMPROVEMENT_SECTION}\\s*\\n`, 'm');
  const sectionMatch = sectionRe.exec(rawSkillMd);
  if (!sectionMatch) {
    return `${trimmedEnd}\n\n## ${SKILL_IMPROVEMENT_SECTION}\n${bullet}\n`;
  }

  const sectionBodyStart = sectionMatch.index + sectionMatch[0].length;
  const afterSectionHeading = rawSkillMd.slice(sectionBodyStart);
  const nextH2Match = /\n##\s+/.exec(afterSectionHeading);
  if (!nextH2Match) {
    return `${trimmedEnd}\n${bullet}\n`;
  }

  const insertAt = sectionBodyStart + nextH2Match.index;
  const before = rawSkillMd.slice(0, insertAt).replace(/\s+$/, '');
  const after = rawSkillMd.slice(insertAt);
  return `${before}\n${bullet}\n${after}`;
}

export function handleSkillImprovement(
  args: HandleSkillImprovementArgs,
): HandleSkillImprovementResult {
  const parsed = parseSkillImprovementBlock(args.rawBlock);
  if ('error' in parsed) {
    const markdown = `## Skill Improvement Error\nMalformed <${SKILL_IMPROVEMENT_TAG}> block: ${parsed.detail}`;
    return {
      ok: false,
      markdown,
      observation: `- Skill improvement block malformed: ${parsed.detail}`,
    };
  }

  if (!isSkillAllowed(parsed.name, args.allowedSkills)) {
    const markdown = `## Skill Improvement Error\nSkill \`${parsed.name}\` is not in this agent's allowed-skills list and cannot be updated.`;
    return {
      ok: false,
      markdown,
      observation: `- skill-improvement("${parsed.name}") blocked by allowed-skills.`,
    };
  }

  if (!loadedSkillIdsContain(args.loadedSkillIds, parsed.name)) {
    const markdown = `## Skill Improvement Error\nSkill \`${parsed.name}\` was not loaded in this session and cannot be updated.`;
    return {
      ok: false,
      markdown,
      observation: `- skill-improvement("${parsed.name}") blocked: skill was not loaded in this session.`,
    };
  }

  const loaded = loadSkillBody(parsed.name, args.paths);
  if (!loaded) {
    const markdown = `## Skill Improvement Error\nSkill \`${parsed.name}\` was not found in project/global/default skill directories.`;
    return {
      ok: false,
      markdown,
      observation: `- skill-improvement("${parsed.name}") failed: skill not found.`,
    };
  }

  if (loaded.source === 'default') {
    const markdown = `## Skill Improvement Error\nSkill \`${parsed.name}\` is a bundled default skill and cannot be updated. Create a project or global skill override before recording learned lessons.`;
    return {
      ok: false,
      markdown,
      observation: `- skill-improvement("${parsed.name}") blocked: default skills are read-only.`,
    };
  }

  const pendingStorePath = pendingSkillImprovementStorePath(
    loaded.skillDir,
    Boolean(loaded.skillTitle),
  );
  try {
    const record: SkillImprovementRecord = {
      id: randomUUID(),
      skillId: parsed.name,
      source: loaded.source,
      entry: parsed.entry,
      status: 'pending',
      createdAt: new Date().toISOString(),
      sessionId: args.provenance?.sessionId ?? null,
      agentId: args.provenance?.agentId ?? null,
    };
    writePendingSkillImprovement(pendingStorePath, record);
    const markdown = [
      '## Skill Improvement Pending Review',
      `Skill \`${parsed.name}\` (${loaded.source}) learning recorded in \`${pendingStorePath}\`.`,
      'It will not affect future skill instructions until reviewed and promoted.',
    ].join('\n');
    return {
      ok: true,
      markdown,
      observation: `- skill-improvement("${parsed.name}") recorded for pending review in ${loaded.source} skill.`,
      record,
    };
  } catch (err) {
    const detail = (err as Error).message;
    const markdown = `## Skill Improvement Error\nCould not update skill \`${parsed.name}\`: ${detail}`;
    return {
      ok: false,
      markdown,
      observation: `- skill-improvement("${parsed.name}") failed: ${detail}`,
    };
  }
}
