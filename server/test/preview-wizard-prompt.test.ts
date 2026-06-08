/**
 * Contract test for the compose-only preview-setup wizard kickoff prompt.
 */
import { describe, it, expect } from 'vitest';
import './setup.js';
import { buildKickoffPrompt } from '../routes/preview-wizard.js';
import type { PreviewSetupDraft } from '../preview-setup-draft.js';

const bootstrapDraft: PreviewSetupDraft = {
  phase: 'bootstrap_compose',
  detected: null,
  bootstrap: {
    file: 'docker-compose.yml',
    entryService: 'web',
    entryPort: 5173,
    services: ['web'],
    stack: 'vite',
    composeYaml: 'services:\n  web:\n    image: node:22-bookworm-slim\n',
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  composeCandidates: [],
  isMonorepo: false,
  readme: { readmePath: null, setupExcerpt: null, hasDockerHints: false, envKeysFromReadme: [] },
  envExamplePath: null,
  envVars: [{ key: 'API_KEY', sources: ['source'], required: false }],
  scriptHints: [],
  composeChecklist: [
    {
      id: 'compose-file-readable',
      category: 'mount',
      title: 'Compose file present for scan',
      description: 'No compose file on disk yet — generate or bootstrap first, then rescan.',
      status: 'warn',
    },
  ],
};

describe('preview-wizard kickoff prompt', () => {
  const prompt = buildKickoffPrompt(
    'demo-project-id',
    '/srv/workspaces/demo',
    '/srv/skill-scripts/preview-setup',
    bootstrapDraft,
    'session-preview-setup-1',
  );

  it('declares guided walkthrough and bound values', () => {
    expect(prompt).toMatch(/guided walkthrough/i);
    expect(prompt).toMatch(/Bound values/);
    expect(prompt).toMatch(/PROJECT_ID.*`demo-project-id`/);
    expect(prompt).toMatch(/PROJECT_CWD.*`\/srv\/workspaces\/demo`/);
    expect(prompt).toMatch(/YOUR SESSION_ID.*`session-preview-setup-1`/);
    expect(prompt).toMatch(/\$AGENT_HUB_URL/);
    expect(prompt).toMatch(/\$AGENT_HUB_API_KEY/);
  });

  it('is self-contained about wizard API auth when skill loading fails', () => {
    expect(prompt).toMatch(/X-API-Key: \$AGENT_HUB_API_KEY/);
    expect(prompt).toMatch(/setup-compose-bootstrap/);
    expect(prompt).toMatch(/setup-apply/);
    expect(prompt).toMatch(/preview\/build/);
    expect(prompt).toMatch(/wizard-complete/);
    expect(prompt).toMatch(/401 or 403/);
    expect(prompt).toMatch(/Never ask the operator to paste a token into chat/);
  });

  it('documents monorepo and README steps', () => {
    expect(prompt).toMatch(/composeCandidates/);
    expect(prompt).toMatch(/README/);
    expect(prompt).toMatch(/setup-compose-bootstrap/);
    expect(prompt).toMatch(/preview\/build/);
  });

  it('does not document legacy script or multi-process wizard paths', () => {
    expect(prompt).not.toMatch(/mode === "script"/);
    expect(prompt).not.toMatch(/multi-process/);
    expect(prompt).not.toMatch(/packageScripts/);
    expect(prompt).not.toMatch(/preview\/detect/);
    expect(prompt).toMatch(/Never.*startScript/i);
  });

  it('embeds draft JSON and setup-apply compose shape', () => {
    expect(prompt).toMatch(/Server-provided draft/);
    expect(prompt).toMatch(/setup-apply/);
    expect(prompt).toMatch(/session_id: "<YOUR SESSION_ID above>"/);
    expect(prompt).toMatch(/"phase":\s*"bootstrap_compose"/);
    expect(prompt).toMatch(/preview\.compose\.healthPath/);
  });

  it('loads the preview-setup skill via the gateway block', () => {
    expect(prompt).toMatch(/<agenthub:skill>/);
    expect(prompt).toMatch(/"name":"preview-setup"/);
    expect(prompt).toMatch(/<\/agenthub:skill>/);
  });

  it('embeds the compose preview checklist and walkthrough step', () => {
    expect(prompt).toMatch(/## Compose preview checklist/);
    expect(prompt).toMatch(/composeChecklist/);
    expect(prompt).toMatch(/Compose preview checklist.*walk `draft\.composeChecklist`/i);
    expect(prompt).toMatch(/AGENTHUB_HOST_PORT/);
    expect(prompt).toMatch(/FRONTEND_PORT/);
  });
});
