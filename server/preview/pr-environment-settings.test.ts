/**
 * With saved Deployments settings, PR environments come from the settings and
 * deploy.yaml at the PR head is never read (the project below has no repo).
 */
import '../test/setup.js';
import { afterEach, describe, expect, it } from 'vitest';
import { probePreviewConfigAtSha } from './pr-environment-config.js';
import { readPreviewConfigAtSha } from './pr-environment-runtime-setup.js';
import { deleteDeploySettings, saveDeploySettings } from '../deploy/deploy-settings-store.js';
import type { Project } from '../types.js';

const project = { id: 'pr-env-settings-project', cwd: '/nonexistent/repo' } as Project;
const SHA = 'a'.repeat(40);

afterEach(() => {
  deleteDeploySettings(project.id);
});

describe('PR environments with saved Deployments settings', () => {
  it('settings without a preview block turn PR environments off', async () => {
    saveDeploySettings(project.id, {}, null, null);
    expect(await probePreviewConfigAtSha(project, SHA)).toBe('absent');
    expect(await readPreviewConfigAtSha(project, SHA)).toBeNull();
  });

  it('the saved preview block is what a PR environment boots', async () => {
    saveDeploySettings(
      project.id,
      {},
      { compose: 'compose.preview.yml', service: 'web', port: 8080 },
      null,
    );
    expect(await probePreviewConfigAtSha(project, SHA)).toBe('present');
    expect(await readPreviewConfigAtSha(project, SHA)).toMatchObject({
      compose: 'compose.preview.yml',
      service: 'web',
      port: 8080,
    });
  });

  it('without settings the repo is consulted (unreadable here, so unresolved)', async () => {
    expect(await probePreviewConfigAtSha(project, SHA)).toBe('unresolved');
  });
});
