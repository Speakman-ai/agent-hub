import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { DeployConfigError, parseDeployConfig } from './deploy-config.js';
import {
  deleteDeploySettings,
  environmentsToDocument,
  previewToDocument,
  getDeploySettings,
  loadEffectiveDeployConfig,
  saveDeploySettings,
} from './deploy-settings-store.js';

const P = 'proj-deploy-settings-test';

const REPO = parseDeployConfig(`
version: 1
environments:
  prod:
    approval: true
    origin: https://app.example.com
    readiness: /health
    steps:
      - name: release
        github_workflow:
          workflow: release-all.yml
          ref: main
          inputs:
            bump: patch
preview:
  compose: docker-compose.yml
  service: web
  port: 3000
`);

beforeEach(() => {
  wipeTables(getDb(), ['deployment_project_settings']);
});

describe('deploy settings store', () => {
  it('round-trips a deploy.yaml environment through the editable document', () => {
    const doc = environmentsToDocument(REPO.environments);
    expect(doc.prod).toEqual({
      approval: true,
      'runs-on': 'ubuntu-24.04',
      timeout_minutes: 60,
      origin: 'https://app.example.com',
      readiness: 'https://app.example.com/health',
      steps: [
        {
          name: 'release',
          github_workflow: { workflow: 'release-all.yml', ref: 'main', inputs: { bump: 'patch' } },
        },
      ],
    });
    const saved = saveDeploySettings(P, doc, null, 'u1');
    expect(saved.environments.get('prod')).toEqual(REPO.environments.get('prod'));
  });

  it('refuses invalid input without writing', () => {
    expect(() => saveDeploySettings(P, { dev: { steps: [] } }, null, null)).toThrow(
      DeployConfigError,
    );
    expect(() => saveDeploySettings(P, { ' dev': { steps: [{ run: 'x' }] } }, null, null)).toThrow(
      /leading or trailing spaces/,
    );
    expect(getDeploySettings(P)).toBeNull();
  });

  it('saved settings replace deploy.yaml entirely, including the preview block', async () => {
    saveDeploySettings(P, { staging: { steps: [{ run: './s.sh' }] } }, null, null);
    const loadRepo = vi.fn(async () => REPO);
    const config = await loadEffectiveDeployConfig(P, loadRepo);
    expect([...config.environments.keys()]).toEqual(['staging']);
    expect(config.preview).toBeNull();
    expect(loadRepo).not.toHaveBeenCalled();
  });

  it('round-trips the preview block and validates it on save', async () => {
    const previewDoc = previewToDocument(REPO.preview!);
    saveDeploySettings(P, {}, previewDoc, null);
    const config = await loadEffectiveDeployConfig(P, async () => {
      throw new DeployConfigError('not_found', 'missing');
    });
    expect(config.preview).toEqual(REPO.preview);
    expect(getDeploySettings(P)?.previewDocument).toEqual(previewDoc);
    expect(() => saveDeploySettings(P, {}, { compose: 'x.yml', service: 'web' }, null)).toThrow(
      DeployConfigError,
    );
    expect(getDeploySettings(P)?.previewDocument).toEqual(previewDoc);
  });

  it('without settings the repo loader result and errors pass through', async () => {
    expect(await loadEffectiveDeployConfig(P, async () => REPO)).toBe(REPO);
    await expect(
      loadEffectiveDeployConfig(P, async () => {
        throw new DeployConfigError('not_found', 'missing');
      }),
    ).rejects.toThrow('missing');
  });

  it('delete reverts to the repo file', async () => {
    saveDeploySettings(P, { staging: { steps: [{ run: './s.sh' }] } }, null, null);
    expect(deleteDeploySettings(P)).toBe(true);
    expect(await loadEffectiveDeployConfig(P, async () => REPO)).toBe(REPO);
  });

  it('keeps environment and workflow input names that collide with Object.prototype', () => {
    const doc = JSON.parse(`{
      "__proto__": { "steps": [{ "name": "a", "run": "./a.sh" }] },
      "constructor": { "steps": [{ "name": "b", "run": "./b.sh" }] },
      "toString": {
        "steps": [{
          "name": "c",
          "github_workflow": {
            "workflow": "r.yml",
            "ref": "main",
            "inputs": { "__proto__": "x", "constructor": "y" }
          }
        }]
      }
    }`);
    const saved = saveDeploySettings(P, doc, null, null);
    expect([...saved.environments.keys()]).toEqual(['__proto__', 'constructor', 'toString']);
    const inputs = saved.environments.get('toString')!.steps[0].githubWorkflow!.inputs!;
    expect(Object.keys(inputs)).toEqual(['__proto__', 'constructor']);

    // Seeding the editor from parsed config must keep every name as an own key.
    const seeded = environmentsToDocument(saved.environments);
    expect(Object.keys(seeded)).toEqual(['__proto__', 'constructor', 'toString']);
    const roundTrip = JSON.parse(JSON.stringify(seeded));
    expect(Object.keys(roundTrip)).toEqual(['__proto__', 'constructor', 'toString']);
    const gw = (roundTrip.toString.steps[0] as { github_workflow: { inputs: object } })
      .github_workflow;
    expect(Object.keys(gw.inputs)).toEqual(['__proto__', 'constructor']);
    const resaved = saveDeploySettings(P, roundTrip, null, null);
    expect([...resaved.environments.keys()]).toEqual(['__proto__', 'constructor', 'toString']);
  });
});
