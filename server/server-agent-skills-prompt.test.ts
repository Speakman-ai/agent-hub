/**
 * The Server Agent's added skills must show up in its Available Skills catalog,
 * including a skill pinned from another project's store.
 */
import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import path from 'path';

const tmpBase = path.join(os.tmpdir(), `server-agent-skills-prompt-${process.pid}`);
const skillsByDir = vi.hoisted(() => new Map<string, Array<{ id: string; description: string }>>());

vi.mock('./db.js', () => ({
  db: {},
  stmts: { getAgentSkillOverrides: { all: () => [] } },
}));
vi.mock('./wiki.js', () => ({ getWikiContext: () => '' }));
vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: (dir: string) =>
    (skillsByDir.get(dir) ?? []).map((s) => ({ ...s, name: s.id, path: path.join(dir, s.id) })),
  DEFAULT_SKILLS_DIR: '/default-skills',
}));
vi.mock('./global-skills-dir.js', () => ({ resolveGlobalSkillsDir: () => '/global-skills' }));
vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));
vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: () => ({ skillsDir: '/hub-skills', contextFiles: {} }),
  contextFilePath: () => null,
}));
vi.mock('./project-model.js', () => ({ allAgents: () => [], findProject: () => null }));

import { buildEnrichedPrompt } from './chat.js';

skillsByDir.set('/default-skills', [
  { id: 'agent-hub', description: 'Hub core' },
  { id: 'github', description: 'GitHub workflows' },
  { id: 'gcloud', description: 'Google Cloud' },
]);
skillsByDir.set('/other-project-skills', [
  { id: 'deploy-prod', description: 'Deploys the other project' },
  { id: 'not-pinned', description: 'Should stay hidden' },
]);

const project = { id: '__hub__', name: 'Hub', cwd: tmpBase, ahw: tmpBase, agents: [] };
const agent = {
  id: '__hub_assistant__',
  name: 'Server Agent',
  engine: 'claude-code',
  role: 'member' as const,
  allowedSkills: ['agent-hub'],
};

function catalog(prompt: string): string {
  return prompt.split('## Available Skills')[1]?.split('\n## ')[0] ?? '';
}

describe('buildEnrichedPrompt — Server Agent added skills', () => {
  it('lists only the agent allowlist without additions', () => {
    const list = catalog(buildEnrichedPrompt(project, agent, { isFirstMessage: true }));
    expect(list).toContain('**agent-hub**');
    expect(list).not.toContain('**github**');
  });

  it('lists added global and pinned project skills', () => {
    const list = catalog(
      buildEnrichedPrompt(project, agent, {
        isFirstMessage: true,
        serverAgentSkills: {
          ids: ['github', 'deploy-prod'],
          pinned: [{ id: 'deploy-prod', root: '/other-project-skills' }],
        },
      }),
    );
    expect(list).toContain('**agent-hub**');
    expect(list).toContain('**github**');
    expect(list).toContain('**deploy-prod**');
    expect(list).not.toContain('**gcloud**');
    expect(list).not.toContain('**not-pinned**');
  });
});
