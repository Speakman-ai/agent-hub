import { Router, Request, Response } from 'express';
import path from 'path';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  cpSync,
} from 'fs';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { RouteDeps, AgentSkillOverrideRow } from '../types.js';
import { extractCredentialsFromSkillContent } from '../skill-credentials-resolve.js';
import { validateAndComposeSkill, validateSkillSlug } from '../skill-write.js';
// The unfiltered options list used by the Settings allowlist editor lives in
// agent-skills-list (built on collectSkillsFromDir below). Importing it here
// keeps the merge defined once; the FS primitive `collectSkillsFromDir` stays
// the seam prompt-builder tests mock. (agent-skills-list re-imports that
// primitive from this module — an ESM-safe cycle: both bindings are only read
// inside functions, never at module top level.)
import { listMergedSkills } from '../agent-skills-list.js';
import { resolveGlobalSkillsDir } from '../global-skills-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.join(__dirname, '..', 'default-skills');
const PLUGIN_DIR = path.join(__dirname, '..', '..', 'plugin');

interface SkillFrontmatter {
  name: string;
  description: string;
  category: string;
  version: string | null;
  keepCodingInstructions: boolean;
  content: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface SkillWithSource extends SkillInfo {
  source: 'project' | 'global' | 'default';
}

/**
 * Merge-sync skills from DEFAULT_SKILLS_DIR and any extra skill directories
 * (e.g. per-project skillsDir entries) into the Claude Code CLI's
 * `~/.claude/plugins/local/agent-hub-skills` plugin target (or the
 * `~/.claude/commands/` fallback when no plugin scaffolding exists).
 *
 * Called at server startup with every project's skillsDir so bundled and
 * per-project skills register with the CLI.
 *
 * Later sources in `extraSkillDirs` override earlier ones when skill IDs
 * collide — later iterations simply `cpSync` on top of the destination.
 */
export function syncSkillsToClaude(extraSkillDirs: string[] = []): void {
  // TODO(skill-gateway): remove after one release once no active sessions rely on the native Skill tool.
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return;

    const pluginMode =
      existsSync(PLUGIN_DIR) && existsSync(path.join(PLUGIN_DIR, '.claude-plugin'));

    if (pluginMode) {
      const pluginDest = path.join(home, '.claude', 'plugins', 'local', 'agent-hub-skills');
      mkdirSync(pluginDest, { recursive: true });
      // 1) Install plugin scaffolding (.claude-plugin/plugin.json + bundled skills).
      cpSync(PLUGIN_DIR, pluginDest, { recursive: true });

      // 2) Merge-sync DEFAULT_SKILLS_DIR + extras into <pluginDest>/skills.
      const skillsTarget = path.join(pluginDest, 'skills');
      mkdirSync(skillsTarget, { recursive: true });
      const sources = [DEFAULT_SKILLS_DIR, ...extraSkillDirs].filter((d) => !!d && existsSync(d));
      let merged = 0;
      for (const src of sources) {
        for (const entry of readdirSync(src, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillSrc = path.join(src, entry.name);
          if (!existsSync(path.join(skillSrc, 'SKILL.md'))) continue;
          cpSync(skillSrc, path.join(skillsTarget, entry.name), { recursive: true });
          merged++;
        }
      }
      console.log(
        `[skills] Installed agent-hub-skills plugin to ${pluginDest} (+${merged} merged from ${sources.length} source(s))`,
      );
      return;
    }

    // Fallback: flat commands dir — one SKILL.md per skill name.
    const commandsDir = path.join(home, '.claude', 'commands');
    const sources = [DEFAULT_SKILLS_DIR, ...extraSkillDirs].filter((d) => !!d && existsSync(d));
    if (sources.length === 0) return;
    mkdirSync(commandsDir, { recursive: true });
    let count = 0;
    for (const src of sources) {
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(src, entry.name, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        const dest = path.join(commandsDir, entry.name + '.md');
        writeFileSync(dest, readFileSync(skillMd, 'utf-8'));
        count++;
      }
    }
    console.log(`[skills] Synced ${count} skills to ${commandsDir}`);
  } catch (e) {
    console.warn('[skills] Failed to sync skills:', (e as Error).message);
  }
}

/**
 * Remove a skill from the Claude Code CLI's native skill targets so a deleted
 * skill stops being discoverable through the native Skill tool without waiting
 * for a restart.
 *
 * This is the inverse of {@link syncSkillsToClaude}, which is purely additive
 * (`cpSync` on top) and therefore can NOT prune a deleted skill — so delete
 * needs its own targeted removal rather than a re-sync. Removes both the
 * plugin-mode target (`~/.claude/plugins/local/agent-hub-skills/skills/<id>`)
 * and the flat commands fallback (`~/.claude/commands/<id>.md`). Best-effort.
 */
export function removeSkillFromClaude(skillId: string): void {
  // TODO(skill-gateway): remove after one release once no active sessions rely on the native Skill tool.
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home || !skillId || skillId !== path.basename(skillId)) return;
    const pluginSkillDir = path.join(
      home,
      '.claude',
      'plugins',
      'local',
      'agent-hub-skills',
      'skills',
      skillId,
    );
    if (existsSync(pluginSkillDir)) rmSync(pluginSkillDir, { recursive: true, force: true });
    const commandFile = path.join(home, '.claude', 'commands', `${skillId}.md`);
    if (existsSync(commandFile)) rmSync(commandFile, { force: true });
  } catch (e) {
    console.warn('[skills] Failed to remove skill from Claude:', (e as Error).message);
  }
}

function readSkillFrontmatter(skillDir: string): SkillFrontmatter | null {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  try {
    const raw = readFileSync(skillMd, 'utf-8');
    const { data, content: _content } = matter(raw);
    return {
      name: (data.name as string) || path.basename(skillDir),
      description: (data.description as string) || '',
      category: (data.category as string) || 'general',
      version: (data.version as string) || null,
      keepCodingInstructions: (data['keep-coding-instructions'] as boolean) || false,
      content: raw,
    };
  } catch {
    return {
      name: path.basename(skillDir),
      description: '',
      category: 'general',
      version: null,
      keepCodingInstructions: false,
      content: '',
    };
  }
}

function collectSkillsFromDir(dir: string): SkillInfo[] {
  if (!dir || !existsSync(dir)) return [];
  const byId = new Map<string, SkillInfo>();
  const flats: SkillInfo[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const fm = readSkillFrontmatter(fullPath);
        if (fm)
          byId.set(entry, {
            id: entry,
            name: fm.name,
            description: fm.description,
            path: fullPath,
          });
      } else if (entry.endsWith('.md')) {
        // Flat skill: the id is the slug WITHOUT the `.md` extension so discovery
        // matches the load path / `resolveSkillInDir` / route `:skillId` /
        // allowlist (all key by bare slug). An id like `foo.md` would make the
        // skill listed but un-editable/un-allowlistable. Parse the file's own
        // frontmatter for name + description, mirroring the directory form.
        const id = entry.slice(0, -3);
        let name = id;
        let description = '';
        try {
          const { data } = matter(readFileSync(fullPath, 'utf-8'));
          if (typeof data.name === 'string' && data.name.trim()) name = data.name;
          if (typeof data.description === 'string') description = data.description;
        } catch {
          /* keep slug fallback */
        }
        flats.push({ id, name, description, path: fullPath });
      }
    }
  } catch {
    /* skip */
  }
  // Directory form wins over a same-id flat file (matches resolveSkillInDir).
  for (const f of flats) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()];
}

/**
 * True when `dir` contains a skill named `slug` in EITHER form that
 * `loadSkillBody` resolves: the directory form (`<dir>/<slug>/SKILL.md`) or the
 * flat form (`<dir>/<slug>.md`). Pure (dir is a parameter) so collision guards
 * stay in lockstep with discovery and can be unit-tested against a temp dir.
 */
export function skillDirHasSkill(dir: string, slug: string): boolean {
  return resolveSkillInDir(dir, slug) !== null;
}

/**
 * Resolve a skill `slug` inside `dir` to its on-disk form, matching how
 * `loadSkillBody` resolves: the directory form (`<dir>/<slug>/SKILL.md`) takes
 * precedence over the flat form (`<dir>/<slug>.md`). Returns the form, the
 * `SKILL.md`/flat-file path to read/write, and (for the directory form) the
 * skill directory to delete. `null` when neither form exists. Used by the
 * global skill read/update/delete routes so all three handle both forms
 * consistently with discovery and the duplicate guard.
 */
export type ResolvedSkill =
  | { kind: 'dir'; dir: string; mdPath: string }
  | { kind: 'flat'; mdPath: string };

export function resolveSkillInDir(dir: string, slug: string): ResolvedSkill | null {
  if (!dir) return null;
  // Directory form counts ONLY when <dir>/<slug>/SKILL.md exists — same as
  // discovery (readSkillFrontmatter) and loadSkillBody. A stale empty or
  // resource-only directory must NOT shadow a valid flat <slug>.md beside it,
  // otherwise GET 404s, PUT writes a stray SKILL.md into the stale dir, and
  // DELETE removes the wrong thing while leaving the flat skill installed.
  const sub = path.join(dir, slug);
  const mdInDir = path.join(sub, 'SKILL.md');
  if (existsSync(mdInDir) && statSync(mdInDir).isFile()) {
    return { kind: 'dir', dir: sub, mdPath: mdInDir };
  }
  const flat = path.join(dir, `${slug}.md`);
  if (existsSync(flat) && statSync(flat).isFile()) {
    return { kind: 'flat', mdPath: flat };
  }
  return null;
}

/**
 * True when `slug` collides with a bundled default skill. The old guard only
 * checked the directory form, so a project/global skill could still shadow a
 * flat `<slug>.md` default and change its behavior everywhere despite the API
 * contract forbidding overrides.
 */
function isBundledDefaultSkill(slug: string): boolean {
  return skillDirHasSkill(DEFAULT_SKILLS_DIR, slug);
}

export default function createSkillRoutes(deps: RouteDeps): Router {
  const { findAgent, findProject, stmts, broadcast } = deps;
  const router = Router();

  // Every project's skills dir, used to re-assert tier precedence in the flat
  // native Skill-tool registry whenever a GLOBAL skill changes. The native
  // target is a single id-keyed namespace with no tier concept, so a global
  // write/delete for an id that a project also defines would otherwise let the
  // lower-precedence global version win (or a delete leave a hole). Passing
  // these as the LAST sources to syncSkillsToClaude — which lets later sources
  // overwrite earlier on id collision — restores project > global > default,
  // matching the Hub gateway (loadSkillBody). Mirrors the startup sync order.
  const projectSkillDirs = (): string[] =>
    deps
      .getProjects()
      .map((p) => (p.ahw ? path.join(p.ahw, 'skills') : ''))
      .filter((d): d is string => !!d);

  // Resolve the writable global skills dir or fail CLOSED. resolveGlobalSkillsDir
  // returns '' when config.dataDir is unusable; without this guard a mutating
  // route would `path.join('', slug)` => a RELATIVE `./slug` under the server
  // process cwd and create/overwrite/delete there. Returns the dir, or null
  // after sending a 503 (the caller must then return).
  const requireGlobalDir = (res: Response): string | null => {
    const dir = resolveGlobalSkillsDir();
    if (!dir) {
      res.status(503).json({
        error: 'Global skills directory is unavailable (server data dir not configured).',
      });
      return null;
    }
    return dir;
  };

  router.get('/api/agents/:agentId/skills', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project } = found;

    try {
      // This is the management/options list that backs the Settings allowlist
      // editor — it MUST stay the UNFILTERED merge so operators can re-add a
      // previously denied skill. Deliberately uses `listMergedSkills`, NOT
      // `listEnabledSkills` (which applies the agent's overrides + allowlist).
      const skillsDir = project.ahw ? path.join(project.ahw, 'skills') : '';
      res.json(listMergedSkills(skillsDir));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // NOTE: `/skills/overrides` MUST be registered before `/skills/:skillId`,
  // otherwise Express matches the later route first with `:skillId='overrides'`
  // and returns 404 (no skill on disk with that name).
  router.get('/api/agents/:agentId/skills/overrides', (req: Request, res: Response) => {
    try {
      const overrides = stmts.getAgentSkillOverrides.all(
        req.params.agentId,
      ) as AgentSkillOverrideRow[];
      res.json(overrides);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/agents/:agentId/skills/:skillId', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(404).json({ error: 'No workspace configured' });

    const skillPath = path.join(found.project.ahw, 'skills', req.params.skillId as string);
    try {
      if (existsSync(skillPath) && statSync(skillPath).isDirectory()) {
        const skillMd = path.join(skillPath, 'SKILL.md');
        if (!existsSync(skillMd)) return res.status(404).json({ error: 'SKILL.md not found' });
        const raw = readFileSync(skillMd, 'utf-8');
        const { data } = matter(raw);
        const credPack = extractCredentialsFromSkillContent(raw);
        if (credPack.error) {
          return res.status(400).json({
            error: `invalid credentials in SKILL.md frontmatter: ${credPack.error}`,
          });
        }
        res.json({
          id: req.params.skillId,
          name: (data.name as string) || req.params.skillId,
          description: (data.description as string) || '',
          content: raw,
          path: skillPath,
          credentials: credPack.credentials,
        });
      } else if (existsSync(skillPath)) {
        const raw = readFileSync(skillPath, 'utf-8');
        const credPackFlat = extractCredentialsFromSkillContent(raw);
        if (credPackFlat.error) {
          return res.status(400).json({
            error: `invalid credentials in SKILL.md frontmatter: ${credPackFlat.error}`,
          });
        }
        res.json({
          id: req.params.skillId,
          name: (req.params.skillId as string).replace('.md', ''),
          description: '',
          content: raw,
          path: skillPath,
          credentials: credPackFlat.credentials,
        });
      } else {
        const defaultPath = path.join(DEFAULT_SKILLS_DIR, req.params.skillId as string);
        if (existsSync(defaultPath) && statSync(defaultPath).isDirectory()) {
          const skillMd = path.join(defaultPath, 'SKILL.md');
          if (existsSync(skillMd)) {
            const raw = readFileSync(skillMd, 'utf-8');
            const { data } = matter(raw);
            const credPackDef = extractCredentialsFromSkillContent(raw);
            if (credPackDef.error) {
              return res.status(400).json({
                error: `invalid credentials in SKILL.md frontmatter: ${credPackDef.error}`,
              });
            }
            return res.json({
              id: req.params.skillId,
              name: (data.name as string) || req.params.skillId,
              description: (data.description as string) || '',
              content: raw,
              path: defaultPath,
              credentials: credPackDef.credentials,
            });
          }
        }
        res.status(404).json({ error: 'Skill not found' });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create a project skill. Writes <project.ahw>/skills/<slug>/SKILL.md.
  // Phase 1 of the Skill Builder epic — see wiki `skill-builder-architecture`.
  router.post('/api/projects/:projectId/skills', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured for project' });

    const composed = validateAndComposeSkill(req.body ?? {});
    if (!composed.ok) return res.status(400).json({ error: composed.error });
    const { slug, content } = composed;

    // A project skill may not shadow a bundled default skill: the default is the
    // canonical version and a same-id project copy would silently override it.
    if (isBundledDefaultSkill(slug)) {
      return res.status(409).json({
        error: `"${slug}" is a bundled default skill and cannot be overridden by a project skill`,
      });
    }

    const skillDir = path.join(project.ahw, 'skills', slug);
    if (existsSync(skillDir)) {
      return res.status(409).json({
        error: `A project skill "${slug}" already exists — use PUT to update it`,
      });
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), content);
      broadcast({
        type: 'skills_update',
        payload: { action: 'installed', skillId: slug, projectId: req.params.projectId },
      });
      // Best-effort: register the new skill with the Claude Code CLI plugin dir
      // so it is loadable in already-running sessions without a server restart.
      try {
        syncSkillsToClaude([path.join(project.ahw, 'skills')]);
      } catch {
        /* non-fatal — discovery still works via the merge list */
      }
      const { data } = matter(content);
      return res.status(201).json({
        id: slug,
        name: (data.name as string) || slug,
        description: (data.description as string) || '',
        path: skillDir,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update an existing project skill's SKILL.md (frontmatter + body).
  router.put('/api/projects/:projectId/skills/:skillId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured for project' });

    const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
    if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
    const skillId = slugRes.slug;

    if (isBundledDefaultSkill(skillId)) {
      return res.status(409).json({
        error: `"${skillId}" is a bundled default skill and cannot be overridden by a project skill`,
      });
    }

    const skillDir = path.join(project.ahw, 'skills', skillId);
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
      return res.status(404).json({ error: 'Project skill not found' });
    }

    const composed = validateAndComposeSkill(req.body ?? {}, { expectedSlug: skillId });
    if (!composed.ok) return res.status(400).json({ error: composed.error });

    try {
      writeFileSync(path.join(skillDir, 'SKILL.md'), composed.content);
      broadcast({
        type: 'skills_update',
        payload: { action: 'updated', skillId, projectId: req.params.projectId },
      });
      try {
        syncSkillsToClaude([path.join(project.ahw, 'skills')]);
      } catch {
        /* non-fatal */
      }
      const { data } = matter(composed.content);
      return res.json({
        id: skillId,
        name: (data.name as string) || skillId,
        description: (data.description as string) || '',
        path: skillDir,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/skills/:skillId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'No workspace' });

    const skillDir = path.join(project.ahw, 'skills', req.params.skillId as string);
    try {
      if (existsSync(skillDir)) {
        const files = readdirSync(skillDir);
        for (const f of files) unlinkSync(path.join(skillDir, f));
        rmdirSync(skillDir);
      }
      broadcast({
        type: 'skills_update',
        payload: {
          action: 'uninstalled',
          skillId: req.params.skillId,
          projectId: req.params.projectId,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Global (shared) skills ─────────────────────────────────────────────
  // A writable shared tier under <dataDir>/skills, read by listMergedSkills +
  // loadSkillBody BETWEEN the project tier and the bundled defaults. A skill
  // authored here is visible to EVERY agent in EVERY project (precedence:
  // project > global > bundled default). See server/global-skills-dir.ts.

  router.get('/api/global-skills', (_req: Request, res: Response) => {
    try {
      const skills: SkillWithSource[] = collectSkillsFromDir(resolveGlobalSkillsDir()).map((s) => ({
        ...s,
        source: 'global',
      }));
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/global-skills/:skillId', (req: Request, res: Response) => {
    const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
    if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
    const globalDir = requireGlobalDir(res);
    if (!globalDir) return;
    // Resolve directory OR flat form so a flat global skill is editable too.
    const resolved = resolveSkillInDir(globalDir, slugRes.slug);
    if (!resolved) return res.status(404).json({ error: 'Global skill not found' });
    try {
      if (!existsSync(resolved.mdPath)) {
        return res.status(404).json({ error: 'SKILL.md not found' });
      }
      const raw = readFileSync(resolved.mdPath, 'utf-8');
      const { data } = matter(raw);
      const credPack = extractCredentialsFromSkillContent(raw);
      if (credPack.error) {
        return res
          .status(400)
          .json({ error: `invalid credentials in SKILL.md frontmatter: ${credPack.error}` });
      }
      res.json({
        id: slugRes.slug,
        name: (data.name as string) || slugRes.slug,
        description: (data.description as string) || '',
        content: raw,
        path: resolved.kind === 'dir' ? resolved.dir : resolved.mdPath,
        credentials: credPack.credentials,
        source: 'global',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create a global skill. Writes <dataDir>/skills/<slug>/SKILL.md.
  router.post('/api/global-skills', (req: Request, res: Response) => {
    const composed = validateAndComposeSkill(req.body ?? {});
    if (!composed.ok) return res.status(400).json({ error: composed.error });
    const { slug, content } = composed;

    const globalDir = requireGlobalDir(res);
    if (!globalDir) return;

    // A global skill may not shadow a bundled default skill (the default is the
    // canonical version and a same-id global copy would silently override it).
    if (isBundledDefaultSkill(slug)) {
      return res.status(409).json({
        error: `"${slug}" is a bundled default skill and cannot be overridden by a global skill`,
      });
    }

    // Duplicate check must cover BOTH skill forms this module resolves — the
    // directory form (<globalDir>/<slug>/SKILL.md) AND the flat form
    // (<globalDir>/<slug>.md) — so a flat global skill can't be silently
    // shadowed by a second directory-form skill of the same id. Mirrors the
    // bundled-default guard.
    const skillDir = path.join(globalDir, slug);
    if (skillDirHasSkill(globalDir, slug)) {
      return res
        .status(409)
        .json({ error: `A global skill "${slug}" already exists — use PUT to update it` });
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), content);
      broadcast({
        type: 'skills_update',
        payload: { action: 'installed', skillId: slug, scope: 'global' },
      });
      try {
        syncSkillsToClaude([globalDir, ...projectSkillDirs()]);
      } catch {
        /* non-fatal — discovery still works via the merge list */
      }
      const { data } = matter(content);
      return res.status(201).json({
        id: slug,
        name: (data.name as string) || slug,
        description: (data.description as string) || '',
        path: skillDir,
        // The web/mobile UIs key off `source` to pick the global delete path,
        // the shared badge, and the cross-project confirmation. Tag the create
        // response so the in-memory `saved` object behaves correctly before a
        // list reload.
        source: 'global',
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update an existing global skill's SKILL.md (frontmatter + body).
  router.put('/api/global-skills/:skillId', (req: Request, res: Response) => {
    const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
    if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
    const skillId = slugRes.slug;

    const globalDir = requireGlobalDir(res);
    if (!globalDir) return;

    if (isBundledDefaultSkill(skillId)) {
      return res.status(409).json({
        error: `"${skillId}" is a bundled default skill and cannot be overridden by a global skill`,
      });
    }

    // Resolve directory OR flat form; rewrite whichever the skill already uses
    // so a pre-existing flat global skill has an update path too.
    const resolved = resolveSkillInDir(globalDir, skillId);
    if (!resolved) {
      return res.status(404).json({ error: 'Global skill not found' });
    }

    const composed = validateAndComposeSkill(req.body ?? {}, { expectedSlug: skillId });
    if (!composed.ok) return res.status(400).json({ error: composed.error });

    try {
      writeFileSync(resolved.mdPath, composed.content);
      broadcast({
        type: 'skills_update',
        payload: { action: 'updated', skillId, scope: 'global' },
      });
      try {
        syncSkillsToClaude([globalDir, ...projectSkillDirs()]);
      } catch {
        /* non-fatal */
      }
      const { data } = matter(composed.content);
      return res.json({
        id: skillId,
        name: (data.name as string) || skillId,
        description: (data.description as string) || '',
        path: resolved.kind === 'dir' ? resolved.dir : resolved.mdPath,
        source: 'global',
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/global-skills/:skillId', (req: Request, res: Response) => {
    const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
    if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
    const globalDir = requireGlobalDir(res);
    if (!globalDir) return;
    try {
      // Remove whichever form exists. Directory form: rmSync recursively so
      // nested resources (references/, scripts/) go too — a flat unlink+rmdir
      // would throw EISDIR/ENOTEMPTY. Flat form: remove the <slug>.md file —
      // otherwise a deletable flat global skill returns ok but stays installed.
      const resolved = resolveSkillInDir(globalDir, slugRes.slug);
      if (resolved) {
        rmSync(resolved.kind === 'dir' ? resolved.dir : resolved.mdPath, {
          recursive: true,
          force: true,
        });
      }
      // Prune the deleted skill from the Claude native skill targets, then
      // re-assert any surviving higher-precedence skill of the same id. A
      // project (or bundled default) skill may share this id and, per
      // project > global > default, must still win in the native registry —
      // so after dropping the global copy we re-sync the default + project
      // tiers, which restores a shadowed same-id skill without re-adding the
      // just-deleted global one (syncSkillsToClaude is additive, never prunes).
      try {
        removeSkillFromClaude(slugRes.slug);
        syncSkillsToClaude(projectSkillDirs());
      } catch {
        /* non-fatal — Hub gateway (loadSkillBody) already reflects the deletion */
      }
      broadcast({
        type: 'skills_update',
        payload: { action: 'uninstalled', skillId: slugRes.slug, scope: 'global' },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/api/agents/:agentId/skills/:skillId/toggle', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });

    const { enabled } = req.body;
    if (enabled === undefined) return res.status(400).json({ error: 'enabled field required' });

    try {
      stmts.upsertAgentSkillOverride.run(req.params.agentId, req.params.skillId, enabled ? 1 : 0);
      broadcast({
        type: 'skills_update',
        payload: {
          action: 'toggled',
          agentId: req.params.agentId,
          skillId: req.params.skillId,
          enabled,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

export { readSkillFrontmatter, collectSkillsFromDir, DEFAULT_SKILLS_DIR };
