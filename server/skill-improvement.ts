import path from 'path';
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync, rmSync, statSync } from 'fs';
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

export interface PendingSkillImprovementRecord {
  id: string;
  skillId: string;
  source: 'project' | 'global';
  entry: string;
  status: 'pending';
  createdAt: string;
}

export interface SkillImprovementMalformed {
  error: 'malformed';
  detail: string;
}

export interface HandleSkillImprovementArgs {
  rawBlock: string;
  paths: SkillInvokePaths;
  allowedSkills?: string[] | null;
  loadedSkillIds: Iterable<string>;
}

export interface HandleSkillImprovementResult {
  ok: boolean;
  markdown: string;
  observation: string;
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
  record: PendingSkillImprovementRecord,
): void {
  mkdirSync(path.dirname(pendingStorePath), { recursive: true });
  withSkillFileLock(pendingStorePath, () => {
    appendFileSync(pendingStorePath, `${JSON.stringify(record)}\n`);
  });
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
    writePendingSkillImprovement(pendingStorePath, {
      id: randomUUID(),
      skillId: parsed.name,
      source: loaded.source,
      entry: parsed.entry,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    const markdown = [
      '## Skill Improvement Pending Review',
      `Skill \`${parsed.name}\` (${loaded.source}) learning recorded in \`${pendingStorePath}\`.`,
      'It will not affect future skill instructions until reviewed and promoted.',
    ].join('\n');
    return {
      ok: true,
      markdown,
      observation: `- skill-improvement("${parsed.name}") recorded for pending review in ${loaded.source} skill.`,
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
