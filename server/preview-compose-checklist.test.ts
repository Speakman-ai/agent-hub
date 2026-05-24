import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildComposePreviewChecklist,
  formatComposeChecklistForPrompt,
} from './preview-compose-checklist.js';

describe('buildComposePreviewChecklist', () => {
  it('flags absolute bind mounts and passes relative + AGENTHUB_HOST_PORT', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-checklist-'));
    writeFileSync(
      path.join(dir, 'compose.preview.yml'),
      `services:
  frontend:
    volumes:
      - ./frontend:/app
    ports:
      - "\${AGENTHUB_HOST_PORT:-4100}:\${FRONTEND_PORT:-4200}"
    environment:
      CHOKIDAR_USEPOLLING: "true"
    command: ng serve --host 0.0.0.0 --port \${FRONTEND_PORT:-4200}
`,
    );

    const items = buildComposePreviewChecklist({
      workspaceDir: dir,
      composeFile: 'compose.preview.yml',
      entryService: 'frontend',
      entryPort: 4200,
      healthPath: '/',
    });

    expect(items.find((i) => i.id === 'relative-volume-paths')?.status).toBe('pass');
    expect(items.find((i) => i.id === 'host-port-env-vars')?.status).toBe('pass');
    expect(items.find((i) => i.id === 'docker-polling-hints')?.status).toBe('pass');
    expect(items.some((i) => i.id === 'worktree-bind-mounts' && i.status === 'manual')).toBe(true);
  });

  it('fails on absolute volume paths and container_name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-checklist-bad-'));
    writeFileSync(
      path.join(dir, 'compose.preview.yml'),
      `services:
  web:
    container_name: my-preview
    volumes:
      - /Users/dev/app:/app
`,
    );

    const items = buildComposePreviewChecklist({
      workspaceDir: dir,
      composeFile: 'compose.preview.yml',
      entryService: 'web',
      entryPort: 3000,
    });

    expect(items.find((i) => i.id === 'relative-volume-paths')?.status).toBe('fail');
    expect(items.find((i) => i.id === 'no-fixed-container-name')?.status).toBe('fail');
  });

  it('warns when compose file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-checklist-empty-'));
    const items = buildComposePreviewChecklist({ workspaceDir: dir });
    expect(items.find((i) => i.id === 'compose-file-readable')?.status).toBe('warn');
  });
});

describe('formatComposeChecklistForPrompt', () => {
  it('includes status badges and titles', () => {
    const text = formatComposeChecklistForPrompt(
      buildComposePreviewChecklist({
        workspaceDir: mkdtempSync(path.join(tmpdir(), 'ah-prompt-')),
      }),
    );
    expect(text).toMatch(/## Compose preview checklist/);
    expect(text).toMatch(/\*\*\[CHECK\]\*\*/);
    expect(text).toMatch(/worktree-bind-mounts|Bind mounts are relative/);
  });
});
