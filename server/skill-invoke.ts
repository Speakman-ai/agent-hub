import path from 'path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_SKILLS_DIR } from './routes/skills.js';
import type { BroadcastFn, Stmts } from './types.js';

const PER_REFERENCE_BYTE_CAP = 8 * 1024;
const TOTAL_REFERENCES_BYTE_CAP = 32 * 1024;
/** Max bytes read from SKILL.md (matches reference bundle budget scale). */
const SKILL_MD_BYTE_CAP = 32 * 1024;

function realpathOrNull(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

/** True when `resolvedChild` is a strict path descendant of `resolvedRoot`. */
function isStrictDescendant(resolvedChild: string, resolvedRoot: string): boolean {
  const rel = path.relative(resolvedRoot, resolvedChild);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Reject path traversal / nested paths so `name` cannot escape the skills directory. */
export function resolveSkillDirUnderBase(baseDir: string, name: string): string | null {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('\0')) return null;
  if (name !== path.basename(name)) return null;

  const base = path.resolve(baseDir);
  const skillDir = path.resolve(base, name);
  const rel = path.relative(base, skillDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return skillDir;
}

export interface SkillInvokeTask {
  name: string;
  reason?: string;
}

export interface SkillInvokeMalformed {
  error: 'malformed';
  detail: string;
}

export interface SkillInvokePaths {
  skillsDir: string;
}

export interface LoadedSkillBody {
  source: 'project' | 'default';
  skillDir: string;
  skillMd: string;
  references: Array<{ path: string; body: string }>;
  scriptListing: string[];
}

interface HandleSkillInvokeArgs {
  rawBlock: string;
  paths: SkillInvokePaths;
  sessionId: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
}

interface LoadSkillByNameArgs {
  name: string;
  reason?: string;
  paths: SkillInvokePaths;
  sessionId: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
}

function collectReferenceFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectReferenceFiles(full, root));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.relative(root, full));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function detectSkillBlock(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const re = /<agenthub:skill>\s*[\s\S]*?\s*<\/agenthub:skill>/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match[0];
  }
  return last;
}

export function parseSkillBlock(raw: string): SkillInvokeTask | SkillInvokeMalformed {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'malformed', detail: 'Empty skill block payload' };
  }

  const tagMatch = raw.match(/<agenthub:skill>\s*([\s\S]*?)\s*<\/agenthub:skill>/i);
  const payload = (tagMatch ? tagMatch[1] : raw).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      error: 'malformed',
      detail: `Invalid JSON: ${(err as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'malformed', detail: 'Skill block payload must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string') {
    return { error: 'malformed', detail: 'Missing required string field: name' };
  }

  const name = obj.name.trim();
  if (!name) {
    return { error: 'malformed', detail: 'Field "name" cannot be empty' };
  }

  if (obj.reason !== undefined && typeof obj.reason !== 'string') {
    return { error: 'malformed', detail: 'Optional field "reason" must be a string' };
  }

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  return reason ? { name, reason } : { name };
}

export function loadSkillBody(name: string, paths: SkillInvokePaths): LoadedSkillBody | null {
  const projectDir = resolveSkillDirUnderBase(paths.skillsDir, name);
  const defaultDir = resolveSkillDirUnderBase(DEFAULT_SKILLS_DIR, name);
  if (!projectDir && !defaultDir) return null;

  const candidates: Array<{ source: 'project' | 'default'; skillDir: string }> = [];
  if (projectDir) candidates.push({ source: 'project', skillDir: projectDir });
  if (defaultDir) candidates.push({ source: 'default', skillDir: defaultDir });

  const found = candidates.find((c) => existsSync(path.join(c.skillDir, 'SKILL.md')));
  if (!found) return null;

  const skillsRoot = found.source === 'project' ? paths.skillsDir : DEFAULT_SKILLS_DIR;
  const rootReal = realpathOrNull(skillsRoot);
  const skillDirReal = realpathOrNull(found.skillDir);
  if (!rootReal || !skillDirReal || !isStrictDescendant(skillDirReal, rootReal)) {
    return null;
  }

  const skillMdPath = path.join(found.skillDir, 'SKILL.md');
  const mdReal = realpathOrNull(skillMdPath);
  if (!mdReal || !isStrictDescendant(mdReal, skillDirReal)) return null;

  const rawMdBuf = readFileSync(skillMdPath);
  const mdSlice = rawMdBuf.subarray(0, Math.min(rawMdBuf.length, SKILL_MD_BYTE_CAP));
  let skillMd = mdSlice.toString('utf-8');
  if (rawMdBuf.length > SKILL_MD_BYTE_CAP) {
    skillMd += '\n\n[Truncated: SKILL.md byte cap reached]';
  }

  const referencesDir = path.join(found.skillDir, 'references');
  const referenceRelPaths = collectReferenceFiles(referencesDir);
  const references: Array<{ path: string; body: string }> = [];

  const refRootReal = existsSync(referencesDir) ? realpathOrNull(referencesDir) : null;

  let remaining = TOTAL_REFERENCES_BYTE_CAP;
  for (const relPath of referenceRelPaths) {
    if (remaining <= 0) break;
    const full = path.join(referencesDir, relPath);
    const refReal = realpathOrNull(full);
    if (!refRootReal || !refReal || !isStrictDescendant(refReal, refRootReal)) continue;

    const raw = readFileSync(full);

    const perFileAllowed = Math.min(PER_REFERENCE_BYTE_CAP, remaining);
    const slice = raw.subarray(0, perFileAllowed);
    let body = slice.toString('utf-8');
    if (raw.length > perFileAllowed) {
      body += '\n\n[Truncated: per-file byte cap reached]';
    }

    references.push({ path: relPath, body });
    remaining -= Buffer.byteLength(body, 'utf-8');
  }

  const scriptsDir = path.join(found.skillDir, 'scripts');
  const scriptListing: string[] = [];
  if (existsSync(scriptsDir)) {
    const scriptsRootReal = realpathOrNull(scriptsDir);
    if (scriptsRootReal) {
      for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(scriptsDir, entry.name);
        const real = realpathOrNull(full);
        if (!real || !isStrictDescendant(real, scriptsRootReal)) continue;
        let executable = false;
        try {
          const mode = statSync(full).mode;
          executable = !!(mode & 0o111);
        } catch {
          executable = false;
        }
        scriptListing.push(`${entry.name}${executable ? ' (executable)' : ''}`);
      }
      scriptListing.sort((a, b) => a.localeCompare(b));
    }
  }

  return {
    source: found.source,
    skillDir: found.skillDir,
    skillMd,
    references,
    scriptListing,
  };
}

export function buildSkillInjection(loaded: LoadedSkillBody): string {
  const skillName = path.basename(loaded.skillDir);
  const lines: string[] = [
    `## Loaded Skill: ${skillName}`,
    `Source: ${loaded.source}`,
    '',
    loaded.skillMd.trim(),
    '',
    '### References',
  ];

  if (loaded.references.length === 0) {
    lines.push('(none)');
  } else {
    for (const ref of loaded.references) {
      lines.push(`#### references/${ref.path}`);
      lines.push('```text');
      lines.push(ref.body.trimEnd());
      lines.push('```');
    }
  }

  lines.push('', '### Available scripts');
  if (loaded.scriptListing.length === 0) {
    lines.push('(none)');
  } else {
    for (const script of loaded.scriptListing) {
      lines.push(`- ${script}`);
    }
  }

  return lines.join('\n');
}

export function handleSkillInvoke(args: HandleSkillInvokeArgs): string {
  const { rawBlock, paths, sessionId, stmts, broadcast } = args;
  const parsed = parseSkillBlock(rawBlock);

  if ('error' in parsed) {
    const injection = `## Skill Load Error\nMalformed <agenthub:skill> block: ${parsed.detail}`;
    try {
      stmts.insertSkillInvocation.run(
        uuidv4(),
        sessionId,
        '(malformed)',
        null,
        null,
        'malformed',
        Buffer.byteLength(injection, 'utf-8'),
      );
      broadcast({
        type: 'skill_invocation',
        sessionId,
        skill_id: '(malformed)',
        status: 'malformed',
      });
    } catch (err) {
      console.log('[skill-invoke] failed to record malformed invocation:', (err as Error).message);
    }
    return injection;
  }

  return loadSkillByName({
    name: parsed.name,
    reason: parsed.reason,
    paths,
    sessionId,
    stmts,
    broadcast,
  });
}

export function loadSkillByName(args: LoadSkillByNameArgs): string {
  const { name, reason, paths, sessionId, stmts, broadcast } = args;

  const loaded = loadSkillBody(name, paths);
  if (!loaded) {
    const injection = `## Skill Load Error\nSkill \`${name}\` was not found in project/default skill directories.`;
    try {
      stmts.insertSkillInvocation.run(
        uuidv4(),
        sessionId,
        name,
        null,
        reason || null,
        'not-found',
        Buffer.byteLength(injection, 'utf-8'),
      );
      broadcast({
        type: 'skill_invocation',
        sessionId,
        skill_id: name,
        status: 'not-found',
      });
    } catch (err) {
      console.log('[skill-invoke] failed to record not-found invocation:', (err as Error).message);
    }
    return injection;
  }

  const injection = buildSkillInjection(loaded);
  try {
    stmts.insertSkillInvocation.run(
      uuidv4(),
      sessionId,
      name,
      loaded.source,
      reason || null,
      'loaded',
      Buffer.byteLength(injection, 'utf-8'),
    );
    broadcast({
      type: 'skill_invocation',
      sessionId,
      skill_id: name,
      source: loaded.source,
      reason: reason || null,
      status: 'loaded',
      injected_bytes: Buffer.byteLength(injection, 'utf-8'),
    });
  } catch (err) {
    console.log('[skill-invoke] failed to record loaded invocation:', (err as Error).message);
  }

  console.log(`[skill-invoke] loaded skill "${name}" for session ${sessionId}`);
  return injection;
}
