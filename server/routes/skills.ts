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
  cpSync,
} from 'fs';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { RouteDeps, AgentSkillOverrideRow } from '../types.js';
import { extractCredentialsFromSkillContent } from '../skill-credentials-resolve.js';
// The unfiltered options list used by the Settings allowlist editor lives in
// agent-skills-list (built on collectSkillsFromDir below). Importing it here
// keeps the merge defined once; the FS primitive `collectSkillsFromDir` stays
// the seam prompt-builder tests mock. (agent-skills-list re-imports that
// primitive from this module — an ESM-safe cycle: both bindings are only read
// inside functions, never at module top level.)
import { listMergedSkills } from '../agent-skills-list.js';

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
  source: 'project' | 'default';
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
  const skills: SkillInfo[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        const fm = readSkillFrontmatter(fullPath);
        if (fm)
          skills.push({ id: entry, name: fm.name, description: fm.description, path: fullPath });
      } else if (entry.endsWith('.md')) {
        skills.push({ id: entry, name: entry.replace('.md', ''), description: '', path: fullPath });
      }
    }
  } catch {
    /* skip */
  }
  return skills;
}

export default function createSkillRoutes(deps: RouteDeps): Router {
  const { findAgent, findProject, stmts, broadcast } = deps;
  const router = Router();

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
