import { Router } from 'express';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.join(__dirname, '..', 'default-skills');
const PLUGIN_DIR = path.join(__dirname, '..', '..', 'plugin');

/**
 * Sync default skills to Claude Code as a proper plugin.
 *
 * Installs to ~/.claude/plugins/local/agent-hub-skills/ using the
 * standard plugin layout (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`).
 * Falls back to the legacy `~/.claude/commands/` sync if the plugin directory
 * is missing from the repo.
 */
(function syncDefaultSkillsToClaude() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return;

    // Prefer plugin-based sync if the plugin/ directory exists in the repo
    if (existsSync(PLUGIN_DIR) && existsSync(path.join(PLUGIN_DIR, '.claude-plugin'))) {
      const pluginDest = path.join(home, '.claude', 'plugins', 'local', 'agent-hub-skills');
      mkdirSync(pluginDest, { recursive: true });
      cpSync(PLUGIN_DIR, pluginDest, { recursive: true });
      console.log(`[skills] Installed agent-hub-skills plugin to ${pluginDest}`);
      return;
    }

    // Legacy fallback: copy SKILL.md files as individual commands
    const commandsDir = path.join(home, '.claude', 'commands');
    if (!existsSync(DEFAULT_SKILLS_DIR)) return;
    mkdirSync(commandsDir, { recursive: true });
    const entries = readdirSync(DEFAULT_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = path.join(DEFAULT_SKILLS_DIR, entry.name, 'SKILL.md');
        if (existsSync(skillMd)) {
          const dest = path.join(commandsDir, entry.name + '.md');
          writeFileSync(dest, readFileSync(skillMd, 'utf-8'));
        }
      }
    }
    console.log(
      `[skills] Synced ${entries.filter((e) => e.isDirectory()).length} default skills to ${commandsDir}`,
    );
  } catch (e) {
    console.warn('[skills] Failed to sync default skills:', e.message);
  }
})();

function readSkillFrontmatter(skillDir) {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  try {
    const raw = readFileSync(skillMd, 'utf-8');
    const { data, content: _content } = matter(raw);
    return {
      name: data.name || path.basename(skillDir),
      description: data.description || '',
      category: data.category || 'general',
      version: data.version || null,
      keepCodingInstructions: data['keep-coding-instructions'] || false,
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

function collectSkillsFromDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  const skills = [];
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

export default function createSkillRoutes(deps) {
  const { findAgent, findProject, stmts, broadcast } = deps;
  const router = Router();

  router.get('/api/agents/:agentId/skills', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project } = found;

    try {
      const projectSkills = (
        project.ahw ? collectSkillsFromDir(path.join(project.ahw, 'skills')) : []
      ).map((s) => ({ ...s, source: 'project' }));
      const defaultSkills = collectSkillsFromDir(DEFAULT_SKILLS_DIR).map((s) => ({
        ...s,
        source: 'default',
      }));
      const projectIds = new Set(projectSkills.map((s) => s.id));
      const merged = [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];
      res.json(merged);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/agents/:agentId/skills/:skillId', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(404).json({ error: 'No workspace configured' });

    const skillPath = path.join(found.project.ahw, 'skills', req.params.skillId);
    try {
      if (existsSync(skillPath) && statSync(skillPath).isDirectory()) {
        const skillMd = path.join(skillPath, 'SKILL.md');
        if (!existsSync(skillMd)) return res.status(404).json({ error: 'SKILL.md not found' });
        const raw = readFileSync(skillMd, 'utf-8');
        const { data } = matter(raw);
        res.json({
          id: req.params.skillId,
          name: data.name || req.params.skillId,
          description: data.description || '',
          content: raw,
          path: skillPath,
        });
      } else if (existsSync(skillPath)) {
        const raw = readFileSync(skillPath, 'utf-8');
        res.json({
          id: req.params.skillId,
          name: req.params.skillId.replace('.md', ''),
          description: '',
          content: raw,
          path: skillPath,
        });
      } else {
        const defaultPath = path.join(DEFAULT_SKILLS_DIR, req.params.skillId);
        if (existsSync(defaultPath) && statSync(defaultPath).isDirectory()) {
          const skillMd = path.join(defaultPath, 'SKILL.md');
          if (existsSync(skillMd)) {
            const raw = readFileSync(skillMd, 'utf-8');
            const { data } = matter(raw);
            return res.json({
              id: req.params.skillId,
              name: data.name || req.params.skillId,
              description: data.description || '',
              content: raw,
              path: defaultPath,
            });
          }
        }
        res.status(404).json({ error: 'Skill not found' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/skills/registry', (req, res) => {
    try {
      const S = stmts;
      if (req.query.q) {
        const q = `%${req.query.q}%`;
        res.json(S.searchSkillRegistry.all(q, q));
      } else if (req.query.category) {
        res.json(S.getSkillRegistryByCategory.all(req.query.category));
      } else {
        res.json(S.getSkillRegistry.all());
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/skills/registry/:id', (req, res) => {
    try {
      const item = stmts.getSkillRegistryItem.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Skill not found in registry' });
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/skills/registry', (req, res) => {
    try {
      const { id, name, description, category, author, source_url, repo_url, version, content } =
        req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const skillId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
      const created = stmts.getSkillRegistryItem.get(skillId);
      broadcast({ type: 'skills_update', payload: { action: 'registry_add', skill: created } });
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/skills/registry/:id', (req, res) => {
    try {
      const item = stmts.getSkillRegistryItem.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      stmts.deleteSkillRegistryItem.run(req.params.id);
      broadcast({
        type: 'skills_update',
        payload: { action: 'registry_remove', skillId: req.params.id },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/projects/:projectId/skills/install', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'Project has no agent workspace' });

    const { skillId } = req.body;
    if (!skillId) return res.status(400).json({ error: 'skillId required' });

    try {
      const registryItem = stmts.getSkillRegistryItem.get(skillId);
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
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/projects/:projectId/skills/:skillId', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'No workspace' });

    const skillDir = path.join(project.ahw, 'skills', req.params.skillId);
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
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/skills/import-github', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
      let rawUrl = url;
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
      const name = data.name || path.basename(url).replace('.md', '');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const description = data.description || '';
      const category = data.category || 'general';

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
      const created = stmts.getSkillRegistryItem.get(id);
      broadcast({ type: 'skills_update', payload: { action: 'registry_add', skill: created } });
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/agents/:agentId/skills/:skillId/toggle', (req, res) => {
    const found = findAgent(req.params.agentId);
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
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/agents/:agentId/skills/overrides', (req, res) => {
    try {
      const overrides = stmts.getAgentSkillOverrides.all(req.params.agentId);
      res.json(overrides);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Plugin packaging endpoints ---

  /**
   * GET /api/skills/plugin-info
   * Returns metadata about the bundled agent-hub-skills plugin.
   */
  router.get('/api/skills/plugin-info', (_req, res) => {
    try {
      const pluginJsonPath = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
      if (!existsSync(pluginJsonPath)) {
        return res.status(404).json({ error: 'Plugin not found' });
      }
      const meta = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
      const skillsDirPath = path.join(PLUGIN_DIR, 'skills');
      const skills = existsSync(skillsDirPath)
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/skills/export-plugin
   * Packages selected skills (or all) into a plugin directory structure.
   * Body: { name, description?, skillIds?: string[] }
   * Returns the generated plugin.json and skill list.
   */
  router.post('/api/skills/export-plugin', (req, res) => {
    const { name, description, skillIds } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const pluginId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const home = process.env.HOME || process.env.USERPROFILE;
      const exportDir = path.join(home, '.claude', 'plugins', 'local', pluginId);

      // Create plugin structure
      mkdirSync(path.join(exportDir, '.claude-plugin'), { recursive: true });
      mkdirSync(path.join(exportDir, 'skills'), { recursive: true });

      // Write plugin.json
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

      // Collect skills to export
      const allSkills = collectSkillsFromDir(DEFAULT_SKILLS_DIR);
      const selectedSkills = skillIds
        ? allSkills.filter((s) => skillIds.includes(s.id))
        : allSkills;

      const exported = [];
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export { readSkillFrontmatter, collectSkillsFromDir, DEFAULT_SKILLS_DIR };
