import path from 'path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_SKILLS_DIR } from './routes/skills.js';
import { resolveGlobalSkillsDir } from './global-skills-dir.js';
import { isSkillAllowed } from './agent-skills-list.js';
import type { BroadcastFn, Stmts } from './types.js';
import {
  detectTagBlockInLastFence,
  extractJsonFromTagBody,
  stripFencedCodeBlockBodies,
} from './action-block-parsing.js';

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
  if (!baseDir || typeof baseDir !== 'string' || !baseDir.trim()) return null;
  if (!name || typeof name !== 'string') return null;
  if (name.includes('\0')) return null;
  if (name !== path.basename(name)) return null;

  const base = path.resolve(baseDir.trim());
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
  source: 'project' | 'global' | 'default';
  skillDir: string;
  /**
   * When the skill is a flat `<skillsRoot>/<id>.md` file, set this so injection
   * titles use the skill id (e.g. `foo`), not the markdown basename (`foo.md`).
   */
  skillTitle?: string;
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
  /**
   * The agent's skill allowlist. `null`/`undefined` => unrestricted (any skill
   * may load). An array restricts loadable skills to its ids — a triggered
   * skill outside the list fails with a clear "not allowed" error.
   */
  allowedSkills?: string[] | null;
}

interface LoadSkillByNameArgs {
  name: string;
  reason?: string;
  paths: SkillInvokePaths;
  sessionId: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
  /** See {@link HandleSkillInvokeArgs.allowedSkills}. */
  allowedSkills?: string[] | null;
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
  // Mask fenced code-block bodies first so a documentation example like
  // ```
  // <agenthub:skill>{"name":"foo"}</agenthub:skill>
  // ```
  // is NOT picked up as a real invocation. Without this, every reply
  // that explains the skill syntax would queue a phantom skill load
  // and trigger an auto-continuation loop until the depth cap hits.
  const scanned = stripFencedCodeBlockBodies(text);
  const re = /<agenthub:skill>\s*[\s\S]*?\s*<\/agenthub:skill>/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(scanned)) !== null) {
    last = match[0];
  }
  if (last) return last;
  // Fallback: some agents follow the documentation example too literally and
  // wrap the block in backtick fences (e.g. ```\n<agenthub:skill>...\n```).
  // The primary pass above masks fenced content, so we missed it. Try again
  // using only the LAST fenced block at the tail of the message — this
  // preserves the guard against mid-message documentation examples while
  // rescuing genuine end-of-turn invocations inside fences.
  return detectTagBlockInLastFence(text, 'agenthub:skill');
}

export function parseSkillBlock(raw: string): SkillInvokeTask | SkillInvokeMalformed {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'malformed', detail: 'Empty skill block payload' };
  }

  const tagMatch = raw.match(/<agenthub:skill>\s*([\s\S]*?)\s*<\/agenthub:skill>/i);
  const payload = (tagMatch ? tagMatch[1] : raw).trim();

  // Tolerate fenced/prose-wrapped/multi-line bodies — see action-block-parsing.ts.
  const normalized = extractJsonFromTagBody(payload);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(payload) : JSON.parse(normalized);
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

function resolveFlatSkillMdUnderSkillsRoot(
  skillsRoot: string,
  name: string,
): { mdPath: string; displayName: string } | null {
  const fileBase = name.endsWith('.md') ? name : `${name}.md`;
  if (fileBase.includes('\0')) return null;
  if (fileBase !== path.basename(fileBase)) return null;

  const baseResolved = path.resolve(skillsRoot);
  const mdPath = path.resolve(baseResolved, fileBase);
  const rel = path.relative(baseResolved, mdPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!existsSync(mdPath) || statSync(mdPath).isDirectory()) return null;

  const displayName = name.endsWith('.md') ? name.replace(/\.md$/i, '') : name;
  return { mdPath, displayName };
}

function loadSkillFromDirectory(
  source: 'project' | 'global' | 'default',
  skillsRoot: string,
  skillDir: string,
): LoadedSkillBody | null {
  const rootReal = realpathOrNull(skillsRoot);
  const skillDirReal = realpathOrNull(skillDir);
  if (!rootReal || !skillDirReal || !isStrictDescendant(skillDirReal, rootReal)) {
    return null;
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const mdReal = realpathOrNull(skillMdPath);
  if (!mdReal || !isStrictDescendant(mdReal, skillDirReal)) return null;

  const rawMdBuf = readFileSync(skillMdPath);
  const mdSlice = rawMdBuf.subarray(0, Math.min(rawMdBuf.length, SKILL_MD_BYTE_CAP));
  let skillMd = mdSlice.toString('utf-8');
  if (rawMdBuf.length > SKILL_MD_BYTE_CAP) {
    skillMd += '\n\n[Truncated: SKILL.md byte cap reached]';
  }

  const referencesDir = path.join(skillDir, 'references');
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

  const scriptsDir = path.join(skillDir, 'scripts');
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
    source,
    skillDir,
    skillMd,
    references,
    scriptListing,
  };
}

function loadSkillFromFlatMarkdownFile(
  source: 'project' | 'global' | 'default',
  skillsRoot: string,
  mdPath: string,
  skillTitle: string,
): LoadedSkillBody | null {
  const rootReal = realpathOrNull(skillsRoot);
  const mdReal = realpathOrNull(mdPath);
  if (!rootReal || !mdReal || !isStrictDescendant(mdReal, rootReal)) return null;

  const rawMdBuf = readFileSync(mdPath);
  const mdSlice = rawMdBuf.subarray(0, Math.min(rawMdBuf.length, SKILL_MD_BYTE_CAP));
  let skillMd = mdSlice.toString('utf-8');
  if (rawMdBuf.length > SKILL_MD_BYTE_CAP) {
    skillMd += '\n\n[Truncated: SKILL.md byte cap reached]';
  }

  return {
    source,
    skillDir: mdPath,
    skillTitle,
    skillMd,
    references: [],
    scriptListing: [],
  };
}

export function loadSkillBody(name: string, paths: SkillInvokePaths): LoadedSkillBody | null {
  const trimmedName = name.trim();
  if (!trimmedName) return null;

  const projectRoot = paths.skillsDir?.trim() ? paths.skillsDir.trim() : '';
  // Search order encodes precedence: project > global > bundled default. The
  // first tier with a matching SKILL.md wins, so a project skill shadows a
  // same-id global one, which shadows a same-id bundled default.
  const searchOrder: Array<{ source: 'project' | 'global' | 'default'; root: string }> = [];
  if (projectRoot) searchOrder.push({ source: 'project', root: projectRoot });
  const globalRoot = resolveGlobalSkillsDir();
  if (globalRoot) searchOrder.push({ source: 'global', root: globalRoot });
  searchOrder.push({ source: 'default', root: DEFAULT_SKILLS_DIR });

  for (const { source, root } of searchOrder) {
    if (!root || !existsSync(root)) continue;

    const dir = resolveSkillDirUnderBase(root, trimmedName);
    if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
      const skillMdPath = path.join(dir, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        const loaded = loadSkillFromDirectory(source, root, dir);
        if (loaded) return loaded;
      }
    }

    const flat = resolveFlatSkillMdUnderSkillsRoot(root, trimmedName);
    if (flat) {
      const loaded = loadSkillFromFlatMarkdownFile(source, root, flat.mdPath, flat.displayName);
      if (loaded) return loaded;
    }
  }

  return null;
}

/**
 * Build the prompt injection for a loaded skill.
 *
 * Wire format (preserved for downstream parsers/UI):
 *
 *   ## Loaded Skill: <name>
 *   Source: <project|default>
 *
 *   <SKILL.md body>
 *
 *   ### References
 *   <lazy index — see below>
 *
 *   ### Available scripts
 *   - <file> [(executable)]
 *   ...
 *
 * Reference bodies are deliberately NOT inlined here. For the `agent-hub`
 * monolith that loaded ~32KB of reference docs into every trigger — most of
 * which were unused for any given turn. Agents now get a navigable index
 * (relative path + absolute path on disk + size) and can `Read` individual
 * files only when they need them. This is the progressive-disclosure model
 * the Anthropic Skills guidance recommends.
 *
 * Note: `LoadedSkillBody.references[*].body` is still populated (and capped)
 * so non-prompt callers — tests, future API endpoints — can opt into bodies
 * without re-reading from disk. Only the prompt-facing injection omits them.
 */
export function buildSkillInjection(loaded: LoadedSkillBody): string {
  const skillName = loaded.skillTitle ?? path.basename(loaded.skillDir);
  const lines: string[] = [
    `## Loaded Skill: ${skillName}`,
    `Source: ${loaded.source}`,
    '',
    loaded.skillMd.trim(),
    '',
    '### Self-improvement',
    'If this task teaches a durable correction or reusable rule for this skill, record it for trusted review before finishing by emitting this control block with a concise, non-secret entry:',
    '<agenthub:skill-improvement>',
    JSON.stringify({
      name: skillName,
      entry: 'Reusable learning that should change future uses of this skill.',
    }),
    '</agenthub:skill-improvement>',
    'Only log fundamental skill behavior, not task-specific facts. The server stores this as pending review and does not change SKILL.md automatically.',
    '',
    '### References',
  ];

  if (loaded.references.length === 0) {
    lines.push('(none)');
  } else {
    lines.push(
      'Reference docs are NOT bulk-loaded. Use the `Read` tool on the absolute path below only when you need a specific reference:',
    );
    for (const ref of loaded.references) {
      const abs = path.join(loaded.skillDir, 'references', ref.path);
      const bytes = Buffer.byteLength(ref.body, 'utf-8');
      lines.push(`- references/${ref.path} — ${bytes} bytes — \`${abs}\``);
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
    allowedSkills: args.allowedSkills,
  });
}

export function loadSkillByName(args: LoadSkillByNameArgs): string {
  const { name, reason, paths, sessionId, stmts, broadcast, allowedSkills } = args;

  // Enforce the per-agent skill allowlist before touching disk. A restricted
  // agent triggering a skill outside its list gets a clear error and the
  // attempt is audited (recorded as not-found — the only non-loaded status the
  // skill_invocations CHECK constraint permits — with a distinct message).
  if (!isSkillAllowed(name, allowedSkills)) {
    const injection = `## Skill Load Error\nSkill \`${name}\` is not in this agent's allowed-skills list and cannot be loaded. Pick a skill from your Available Skills list, or ask an operator to grant access under Settings → Agents → Allowed skills.`;
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
      console.log(
        '[skill-invoke] failed to record not-allowed invocation:',
        (err as Error).message,
      );
    }
    console.log(
      `[skill-invoke] blocked skill "${name}" for session ${sessionId} (not in allowlist)`,
    );
    return injection;
  }

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
