/**
 * ensureHubProject must keep the Hub workspace directory (the spawn cwd for
 * daily-summary / heartbeat one-shots) present on disk even when the project
 * row already exists. Regression for the "Working directory does not exist:
 * .../__hub__/workspace" 500 when regenerating the daily summary after the
 * on-disk workspace was removed (data-dir restore / container rebuild).
 */
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './types.js';

let dataRoot: string;
let currentProject: Project | null;
const projectsArray: Project[] = [];
const saveProjects = vi.fn();

vi.mock('./project-model.js', () => ({
  getProjectDataDir: (projectId: string) => path.join(dataRoot, projectId),
  findProject: () => currentProject,
  getProjects: () => projectsArray,
  saveProjects: (...args: unknown[]) => saveProjects(...args),
  findAgent: () => null,
}));

const { ensureHubProject } = await import('./hub-assistant.js');
const { HUB_PROJECT_ID } = await import('../shared/utils/hub.js');

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), 'hub-assistant-'));
  currentProject = null;
  projectsArray.length = 0;
  saveProjects.mockClear();
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('ensureHubProject', () => {
  it('creates the workspace dir when the project row does not exist yet', () => {
    const project = ensureHubProject();
    expect(project.id).toBe(HUB_PROJECT_ID);
    expect(existsSync(project.cwd)).toBe(true);
    expect(projectsArray).toHaveLength(1);
  });

  it('recreates the workspace dir when the row exists but the dir was removed', () => {
    const cwd = path.join(dataRoot, HUB_PROJECT_ID, 'workspace');
    currentProject = {
      id: HUB_PROJECT_ID,
      name: 'Hub',
      cwd,
      ahw: path.join(dataRoot, HUB_PROJECT_ID),
      color: '#22d3ee',
      mode: 'workflow',
      kind: 'system',
      agents: [],
    };
    // The row is present, but nothing exists on disk (the failure the bug hit).
    expect(existsSync(cwd)).toBe(false);

    const project = ensureHubProject();

    expect(project).toBe(currentProject);
    expect(existsSync(cwd)).toBe(true);
  });

  it('backfills an empty cwd on the existing row and persists it', () => {
    currentProject = {
      id: HUB_PROJECT_ID,
      name: 'Hub',
      cwd: '',
      ahw: path.join(dataRoot, HUB_PROJECT_ID),
      color: '#22d3ee',
      mode: 'workflow',
      kind: 'system',
      agents: [],
    };

    const project = ensureHubProject();

    expect(project.cwd.trim()).not.toBe('');
    expect(existsSync(project.cwd)).toBe(true);
    expect(saveProjects).toHaveBeenCalled();
  });
});
