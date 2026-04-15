#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface LegacyAgent {
  id: string;
  name: string;
  engine?: string;
  systemPrompt?: string;
  color?: string;
  cwd?: string;
  workspace?: string;
  heartbeat?: { enabled: boolean; interval: string; prompt: string };
  active?: boolean;
  [key: string]: unknown;
}

interface ProjectMeta {
  id: string;
  name: string;
  cwd: string;
  oldWorkspace: string;
  color: string;
  agents: (LegacyAgent & { shortName: string })[];
}

interface ProjectAgent {
  id: string;
  name: string;
  engine: string;
  systemPrompt: string;
  color: string;
  heartbeat: { enabled: boolean; interval: string; prompt: string };
  active?: boolean;
}

interface OutputProject {
  id: string;
  name: string;
  cwd: string;
  ahw: string;
  color: string;
  agents: ProjectAgent[];
}

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const dryRun: boolean = !process.argv.includes('--apply');

if (dryRun) {
  console.log('=== DRY RUN (pass --apply to execute) ===\n');
}

const agentsPath: string = path.join(__dirname, 'agents.json');
const agents: LegacyAgent[] = JSON.parse(readFileSync(agentsPath, 'utf-8'));

const SHARED_FILES: string[] = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'CLAUDE.md',
];
const AGENT_FILES: string[] = ['IDENTITY.md'];
const SHARED_DIRS: string[] = ['skills', 'memory'];

let configData: Record<string, unknown> = {};
try {
  configData = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch {
  /* ok */
}
const defaultCwd: string = (configData.defaultCwd as string) || process.env.HOME || '/home/user';

function inferProjectId(agent: LegacyAgent): string {
  const suffixes = ['-dev', '-reviewer', '-ops', '-maint', '-helper', '-advisor'];
  for (const suffix of suffixes) {
    if (agent.id.endsWith(suffix)) {
      return agent.id.slice(0, -suffix.length);
    }
  }
  return agent.id;
}

function inferProjectName(agent: LegacyAgent): string {
  const suffixes = [' Dev', ' Reviewer', ' Ops', ' Helper', ' Maint', ' Advisor'];
  for (const suffix of suffixes) {
    if (agent.name.endsWith(suffix)) {
      return agent.name.slice(0, -suffix.length).trim();
    }
  }
  return agent.name;
}

function inferAgentShortName(agent: LegacyAgent, projectName: string): string {
  if (agent.name.startsWith(projectName)) {
    const remainder = agent.name.slice(projectName.length).trim();
    return remainder || agent.name;
  }
  return agent.name;
}

const projectMap = new Map<string, ProjectMeta>();

for (const agent of agents) {
  const projectId: string = inferProjectId(agent);

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

  const project = projectMap.get(projectId)!;
  project.agents.push({
    ...agent,
    shortName: inferAgentShortName(agent, project.name),
  });
}

const HOME: string = process.env.HOME || defaultCwd;
const projectsDir: string = path.join(HOME, '.openclaw', 'projects');
const projects: OutputProject[] = [];

for (const [projectId, meta] of projectMap) {
  const ahwDir: string = path.join(projectsDir, projectId, 'ahw');
  const oldWorkspace: string = meta.oldWorkspace;

  console.log(`Project: ${meta.name} (${projectId})`);
  console.log(`  cwd: ${meta.cwd}`);
  console.log(`  ahw: ${ahwDir}`);
  console.log(`  old workspace: ${oldWorkspace || '(none)'}`);

  if (!dryRun) {
    mkdirSync(ahwDir, { recursive: true });
  }

  if (oldWorkspace && existsSync(oldWorkspace)) {
    for (const file of SHARED_FILES) {
      const src: string = path.join(oldWorkspace, file);
      const dest: string = path.join(ahwDir, file);
      if (existsSync(src)) {
        console.log(`  copy shared: ${file}`);
        if (!dryRun) {
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        }
      }
    }

    for (const dir of SHARED_DIRS) {
      const srcDir: string = path.join(oldWorkspace, dir);
      if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
        console.log(`  copy shared dir: ${dir}/`);
        if (!dryRun) {
          copyDirRecursive(srcDir, path.join(ahwDir, dir));
        }
      }
    }

    try {
      for (const entry of readdirSync(oldWorkspace)) {
        const ext: string = path.extname(entry).toLowerCase();
        if (['.yaml', '.yml', '.png', '.jpg', '.json'].includes(ext)) {
          const src: string = path.join(oldWorkspace, entry);
          if (statSync(src).isFile()) {
            console.log(`  copy asset: ${entry}`);
            if (!dryRun) {
              copyFileSync(src, path.join(ahwDir, entry));
            }
          }
        }
      }
    } catch {
      /* ok */
    }
  }

  const projectAgents: ProjectAgent[] = [];
  for (const agent of meta.agents) {
    const agentDir: string = path.join(ahwDir, 'agents', agent.id);
    console.log(`  agent: ${agent.shortName} (${agent.id})`);

    if (!dryRun) {
      mkdirSync(agentDir, { recursive: true });
    }

    const agentOldWorkspace: string = agent.workspace || oldWorkspace;
    if (agentOldWorkspace && existsSync(agentOldWorkspace)) {
      for (const file of AGENT_FILES) {
        const src: string = path.join(agentOldWorkspace, file);
        const dest: string = path.join(agentDir, file);
        if (existsSync(src)) {
          console.log(`    copy agent-specific: ${file}`);
          if (!dryRun) {
            mkdirSync(path.dirname(dest), { recursive: true });
            copyFileSync(src, dest);
          }
        }
      }
    }

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

const outputPath: string = path.join(__dirname, 'projects.json');
console.log(`\nWriting ${outputPath}`);
console.log(
  `  ${projects.length} projects, ${projects.reduce((n, p) => n + p.agents.length, 0)} agents total`,
);

if (!dryRun) {
  writeFileSync(outputPath, JSON.stringify(projects, null, 2) + '\n');

  const backupPath: string = path.join(__dirname, 'agents.json.backup');
  copyFileSync(agentsPath, backupPath);
  console.log(`\nBacked up agents.json → agents.json.backup`);
}

console.log(dryRun ? '\n=== DRY RUN COMPLETE ===' : '\n=== MIGRATION COMPLETE ===');

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath: string = path.join(src, entry);
    const destPath: string = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
