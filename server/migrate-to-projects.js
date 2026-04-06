#!/usr/bin/env node
/**
 * One-time migration: converts agents.json → projects.json
 *
 * Groups agents into projects by inferring from their workspace paths.
 * Creates the ahw/ directory structure and copies shared + agent-specific files.
 *
 * Usage:
 *   node migrate-to-projects.js              # dry-run (shows what would happen)
 *   node migrate-to-projects.js --apply      # actually do it
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = !process.argv.includes('--apply');

if (dryRun) {
  console.log('=== DRY RUN (pass --apply to execute) ===\n');
}

// Load existing agents
const agentsPath = path.join(__dirname, 'agents.json');
const agents = JSON.parse(readFileSync(agentsPath, 'utf-8'));

// Shared context files that live at project level
const SHARED_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md', 'CLAUDE.md'];
// Agent-specific file
const AGENT_FILES = ['IDENTITY.md'];
// Directories to copy at project level
const SHARED_DIRS = ['skills', 'memory'];

// Load config for defaults
let config = {};
try {
  config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch { /* ok */ }
const defaultCwd = config.defaultCwd || process.env.HOME || '/home/user';

/**
 * Infer a project ID from an agent.
 * Rules:
 *   - If agent.id ends with '-dev', '-reviewer', '-ops', etc., strip the suffix
 *   - Otherwise, use agent.id as-is
 */
function inferProjectId(agent) {
  const suffixes = ['-dev', '-reviewer', '-ops', '-maint', '-helper', '-advisor'];
  for (const suffix of suffixes) {
    if (agent.id.endsWith(suffix)) {
      return agent.id.slice(0, -suffix.length);
    }
  }
  return agent.id;
}

/**
 * Infer a human-friendly project name from the agent name.
 */
function inferProjectName(agent) {
  const suffixes = [' Dev', ' Reviewer', ' Ops', ' Helper', ' Maint', ' Advisor'];
  for (const suffix of suffixes) {
    if (agent.name.endsWith(suffix)) {
      return agent.name.slice(0, -suffix.length).trim();
    }
  }
  return agent.name;
}

/**
 * Infer a short agent name (role) from the full agent name.
 */
function inferAgentShortName(agent, projectName) {
  if (agent.name.startsWith(projectName)) {
    const remainder = agent.name.slice(projectName.length).trim();
    return remainder || agent.name;
  }
  return agent.name;
}

// ─── Group agents into projects ──────────────────────────────────
const projectMap = new Map(); // projectId -> { agents: [], ...meta }

for (const agent of agents) {
  const projectId = inferProjectId(agent);

  if (!projectMap.has(projectId)) {
    projectMap.set(projectId, {
      id: projectId,
      name: inferProjectName(agent),
      cwd: agent.cwd || defaultCwd,
      oldWorkspace: agent.workspace || '',
      color: agent.color || '#6b7280',
      agents: [],
    });
  }

  const project = projectMap.get(projectId);
  project.agents.push({
    ...agent,
    shortName: inferAgentShortName(agent, project.name),
  });
}

// ─── Build projects.json and create directories ──────────────────
const HOME = process.env.HOME || defaultCwd;
const projectsDir = path.join(HOME, '.openclaw', 'projects');
const projects = [];

for (const [projectId, meta] of projectMap) {
  const ahwDir = path.join(projectsDir, projectId, 'ahw');
  const oldWorkspace = meta.oldWorkspace;

  console.log(`Project: ${meta.name} (${projectId})`);
  console.log(`  cwd: ${meta.cwd}`);
  console.log(`  ahw: ${ahwDir}`);
  console.log(`  old workspace: ${oldWorkspace || '(none)'}`);

  // Create ahw directory
  if (!dryRun) {
    mkdirSync(ahwDir, { recursive: true });
  }

  // Copy shared files from old workspace → ahw/
  if (oldWorkspace && existsSync(oldWorkspace)) {
    for (const file of SHARED_FILES) {
      const src = path.join(oldWorkspace, file);
      const dest = path.join(ahwDir, file);
      if (existsSync(src)) {
        console.log(`  copy shared: ${file}`);
        if (!dryRun) {
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        }
      }
    }

    // Copy shared directories
    for (const dir of SHARED_DIRS) {
      const srcDir = path.join(oldWorkspace, dir);
      if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
        console.log(`  copy shared dir: ${dir}/`);
        if (!dryRun) {
          copyDirRecursive(srcDir, path.join(ahwDir, dir));
        }
      }
    }

    // Copy any .yaml, .png, .json files at workspace root (project-specific assets)
    try {
      for (const entry of readdirSync(oldWorkspace)) {
        const ext = path.extname(entry).toLowerCase();
        if (['.yaml', '.yml', '.png', '.jpg', '.json'].includes(ext)) {
          const src = path.join(oldWorkspace, entry);
          if (statSync(src).isFile()) {
            console.log(`  copy asset: ${entry}`);
            if (!dryRun) {
              copyFileSync(src, path.join(ahwDir, entry));
            }
          }
        }
      }
    } catch { /* ok */ }
  }

  // Process each agent
  const projectAgents = [];
  for (const agent of meta.agents) {
    const agentDir = path.join(ahwDir, 'agents', agent.id);
    console.log(`  agent: ${agent.shortName} (${agent.id})`);

    if (!dryRun) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Move IDENTITY.md to agent-specific dir
    const agentOldWorkspace = agent.workspace || oldWorkspace;
    if (agentOldWorkspace && existsSync(agentOldWorkspace)) {
      for (const file of AGENT_FILES) {
        const src = path.join(agentOldWorkspace, file);
        const dest = path.join(agentDir, file);
        if (existsSync(src)) {
          console.log(`    copy agent-specific: ${file}`);
          if (!dryRun) {
            mkdirSync(path.dirname(dest), { recursive: true });
            copyFileSync(src, dest);
          }
        }
      }
    }

    // Build clean agent object (no cwd, no workspace)
    projectAgents.push({
      id: agent.id,
      name: agent.shortName,
      engine: agent.engine || 'claude-code',
      systemPrompt: agent.systemPrompt || '',
      color: agent.color || meta.color,
      heartbeat: agent.heartbeat || { enabled: false, interval: '', prompt: '' },
      ...(agent.active !== undefined ? { active: agent.active } : {}),
    });
  }

  projects.push({
    id: projectId,
    name: meta.name,
    cwd: meta.cwd,
    ahw: ahwDir,
    color: meta.color,
    agents: projectAgents,
  });

  console.log();
}

// ─── Write projects.json ─────────────────────────────────────────
const outputPath = path.join(__dirname, 'projects.json');
console.log(`\nWriting ${outputPath}`);
console.log(`  ${projects.length} projects, ${projects.reduce((n, p) => n + p.agents.length, 0)} agents total`);

if (!dryRun) {
  writeFileSync(outputPath, JSON.stringify(projects, null, 2) + '\n');

  // Backup agents.json
  const backupPath = path.join(__dirname, 'agents.json.backup');
  copyFileSync(agentsPath, backupPath);
  console.log(`\nBacked up agents.json → agents.json.backup`);
}

console.log(dryRun ? '\n=== DRY RUN COMPLETE ===' : '\n=== MIGRATION COMPLETE ===');

// ─── Helpers ─────────────────────────────────────────────────────

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
