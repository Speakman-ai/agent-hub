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
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { RouteDeps, SkillRegistryRow, AgentSkillOverrideRow, Project } from '../types.js';

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

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

interface SkillWithSource extends SkillInfo {
  source: 'project' | 'default';
}

interface PluginSkillInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string | null;
  keepCodingInstructions: boolean;
}

/**
 * Merge-sync skills from DEFAULT_SKILLS_DIR and any extra skill directories
 * (e.g. per-project skillsDir entries) into the Claude Code CLI's
 * `~/.claude/plugins/local/agent-hub-skills` plugin target (or the
 * `~/.claude/commands/` fallback when no plugin scaffolding exists).
 *
 * Called at server startup with every project's skillsDir, and again by
 * the ClawHub install route so freshly-installed project skills register
 * with the CLI without requiring a server restart.
 *
 * Later sources in `extraSkillDirs` override earlier ones when skill IDs
 * collide — later iterations simply `cpSync` on top of the destination.
 */
export function syncSkillsToClaude(extraSkillDirs: string[] = []): void {
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
      const projectSkills: SkillWithSource[] = (
        project.ahw ? collectSkillsFromDir(path.join(project.ahw, 'skills')) : []
      ).map((s) => ({ ...s, source: 'project' as const }));
      const defaultSkills: SkillWithSource[] = collectSkillsFromDir(DEFAULT_SKILLS_DIR).map(
        (s) => ({
          ...s,
          source: 'default' as const,
        }),
      );
      const projectIds = new Set(projectSkills.map((s) => s.id));
      const merged = [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];
      res.json(merged);
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
        res.json({
          id: req.params.skillId,
          name: (data.name as string) || req.params.skillId,
          description: (data.description as string) || '',
          content: raw,
          path: skillPath,
        });
      } else if (existsSync(skillPath)) {
        const raw = readFileSync(skillPath, 'utf-8');
        res.json({
          id: req.params.skillId,
          name: (req.params.skillId as string).replace('.md', ''),
          description: '',
          content: raw,
          path: skillPath,
        });
      } else {
        const defaultPath = path.join(DEFAULT_SKILLS_DIR, req.params.skillId as string);
        if (existsSync(defaultPath) && statSync(defaultPath).isDirectory()) {
          const skillMd = path.join(defaultPath, 'SKILL.md');
          if (existsSync(skillMd)) {
            const raw = readFileSync(skillMd, 'utf-8');
            const { data } = matter(raw);
            return res.json({
              id: req.params.skillId,
              name: (data.name as string) || req.params.skillId,
              description: (data.description as string) || '',
              content: raw,
              path: defaultPath,
            });
          }
        }
        res.status(404).json({ error: 'Skill not found' });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/skills/registry', (req: Request, res: Response) => {
    try {
      const S = stmts;
      if (req.query.q) {
        const q = `%${req.query.q}%`;
        res.json(S.searchSkillRegistry.all(q, q) as SkillRegistryRow[]);
      } else if (req.query.category) {
        res.json(S.getSkillRegistryByCategory.all(req.query.category) as SkillRegistryRow[]);
      } else {
        res.json(S.getSkillRegistry.all() as SkillRegistryRow[]);
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/skills/registry/:id', (req: Request, res: Response) => {
    try {
      const item = stmts.getSkillRegistryItem.get(req.params.id) as SkillRegistryRow | undefined;
      if (!item) return res.status(404).json({ error: 'Skill not found in registry' });
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/skills/registry', (req: Request, res: Response) => {
    try {
      const { id, name, description, category, author, source_url, repo_url, version, content } =
        req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const skillId = id || (name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      stmts.createSkillRegistryItem.run(
        skillId,
        name,
        description || '',
        category || 'general',
        author || '',
        source_url || null,
        repo_url || null,
        version || null,
        content || '',
      );
      const created = stmts.getSkillRegistryItem.get(skillId) as SkillRegistryRow;
      broadcast({ type: 'skills_update', payload: { action: 'registry_add', skill: created } });
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/skills/registry/:id', (req: Request, res: Response) => {
    try {
      const item = stmts.getSkillRegistryItem.get(req.params.id) as SkillRegistryRow | undefined;
      if (!item) return res.status(404).json({ error: 'Not found' });
      stmts.deleteSkillRegistryItem.run(req.params.id);
      broadcast({
        type: 'skills_update',
        payload: { action: 'registry_remove', skillId: req.params.id },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/projects/:projectId/skills/install', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'Project has no agent workspace' });

    const { skillId } = req.body;
    if (!skillId) return res.status(400).json({ error: 'skillId required' });

    try {
      const registryItem = stmts.getSkillRegistryItem.get(skillId) as SkillRegistryRow | undefined;
      if (!registryItem) return res.status(404).json({ error: 'Skill not found in registry' });

      const skillsDir = path.join(project.ahw, 'skills', skillId);
      if (!existsSync(path.join(project.ahw, 'skills'))) {
        mkdirSync(path.join(project.ahw, 'skills'), { recursive: true });
      }
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }
      writeFileSync(path.join(skillsDir, 'SKILL.md'), registryItem.content);

      const userCmdDir = path.join(homedir(), '.claude', 'commands');
      if (existsSync(userCmdDir)) {
        const destDir = path.join(userCmdDir, skillId);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        writeFileSync(path.join(destDir, 'SKILL.md'), registryItem.content);
      }

      stmts.incrementSkillInstallCount.run(skillId);
      broadcast({
        type: 'skills_update',
        payload: { action: 'installed', skillId, projectId: req.params.projectId },
      });
      res.json({ ok: true, path: skillsDir });
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

  router.post('/api/skills/import-github', async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
      let rawUrl: string = url;
      if (url.includes('github.com') && !url.includes('raw.githubusercontent.com')) {
        rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
      }
      if (rawUrl.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/?$/)) {
        rawUrl = rawUrl.replace(/\/?$/, '/main/SKILL.md');
      }

      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
      const content = await response.text();

      const { data } = matter(content);
      const name = (data.name as string) || path.basename(url).replace('.md', '');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const description = (data.description as string) || '';
      const category = (data.category as string) || 'general';

      stmts.createSkillRegistryItem.run(
        id,
        name,
        description,
        category,
        '',
        url,
        url,
        '1.0.0',
        content,
      );
      const created = stmts.getSkillRegistryItem.get(id) as SkillRegistryRow;
      broadcast({ type: 'skills_update', payload: { action: 'registry_add', skill: created } });
      res.status(201).json(created);
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

  router.get('/api/skills/plugin-info', (_req: Request, res: Response) => {
    try {
      const pluginJsonPath = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
      if (!existsSync(pluginJsonPath)) {
        return res.status(404).json({ error: 'Plugin not found' });
      }
      const meta = JSON.parse(readFileSync(pluginJsonPath, 'utf-8')) as Record<string, unknown>;
      const skillsDirPath = path.join(PLUGIN_DIR, 'skills');
      const skills: PluginSkillInfo[] = existsSync(skillsDirPath)
        ? readdirSync(skillsDirPath, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => {
              const fm = readSkillFrontmatter(path.join(skillsDirPath, e.name));
              return {
                id: e.name,
                name: fm?.name || e.name,
                description: fm?.description || '',
                category: fm?.category || 'general',
                version: fm?.version || null,
                keepCodingInstructions: fm?.keepCodingInstructions || false,
              };
            })
        : [];
      res.json({ ...meta, skills });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/skills/export-plugin', (req: Request, res: Response) => {
    const { name, description, skillIds } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const pluginId = (name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const home = process.env.HOME || process.env.USERPROFILE;
      const exportDir = path.join(home!, '.claude', 'plugins', 'local', pluginId);

      mkdirSync(path.join(exportDir, '.claude-plugin'), { recursive: true });
      mkdirSync(path.join(exportDir, 'skills'), { recursive: true });

      const pluginMeta = {
        name: pluginId,
        version: '1.0.0',
        description: description || `${name} skills plugin`,
        author: { name: 'Agent Hub' },
      };
      writeFileSync(
        path.join(exportDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify(pluginMeta, null, 2),
      );

      const allSkills = collectSkillsFromDir(DEFAULT_SKILLS_DIR);
      const selectedSkills = skillIds
        ? allSkills.filter((s) => (skillIds as string[]).includes(s.id))
        : allSkills;

      const exported: Array<{ id: string; name: string }> = [];
      for (const skill of selectedSkills) {
        const srcMd = path.join(skill.path, 'SKILL.md');
        if (!existsSync(srcMd)) continue;
        const destDir = path.join(exportDir, 'skills', skill.id);
        mkdirSync(destDir, { recursive: true });
        writeFileSync(path.join(destDir, 'SKILL.md'), readFileSync(srcMd, 'utf-8'));
        exported.push({ id: skill.id, name: skill.name });
      }

      broadcast({
        type: 'skills_update',
        payload: { action: 'plugin_exported', pluginId, skills: exported },
      });
      res.json({ ok: true, pluginId, path: exportDir, skills: exported });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

export { readSkillFrontmatter, collectSkillsFromDir, DEFAULT_SKILLS_DIR };
