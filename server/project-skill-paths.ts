import { rmSync } from 'fs';
import path from 'path';
import config from './config.js';

let activeDataDir: string = config.dataDir;

export function setProjectSkillsDataDir(dataDir: string): void {
  activeDataDir = dataDir;
}

export function resolveProjectSkillsDir(project: { id: string; ahw?: string }): string {
  return project.id ? path.join(activeDataDir, 'project-skills', project.id) : '';
}

export function deleteProjectSkillsDir(project: { id: string; ahw?: string }): void {
  const skillsDir = resolveProjectSkillsDir(project);
  if (!skillsDir) return;
  rmSync(skillsDir, { recursive: true, force: true });
}
