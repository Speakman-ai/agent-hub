import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const readmeLower = readme.toLowerCase();

/**
 * The public README is a positioning artifact, not just docs. These assertions
 * pin the sovereignty / self-hosted DevSecOps framing chosen in the
 * "Self-Hosted Platform Strategy & Positioning" ADR so a future edit can't
 * silently regress it back to an "AI coding assistant" pitch.
 */
describe('README sovereignty positioning', () => {
  it('leads with the sovereignty headline', () => {
    expect(readme).toContain('Your entire SDLC runs in your VPC and never phones home.');
  });

  it('frames the product as a self-hosted DevSecOps platform', () => {
    expect(readmeLower).toContain('self-hosted devsecops platform');
  });

  it('explicitly rejects the AI-coding-assistant framing', () => {
    expect(readmeLower).toContain('not an ai coding assistant');
  });

  it('makes the consolidation / ROI case with a displaces table', () => {
    // The consolidation table lists the point tools Agent Hub replaces.
    for (const tool of ['LogRocket', 'FullStory']) {
      expect(readme).toContain(tool);
    }
    expect(readmeLower).toContain('displaces');
  });

  it('covers the full SDLC surface: git, CI, security, replay, deploy', () => {
    for (const capability of [
      'issue tracking',
      'code review',
      'ci gating',
      'session replay',
      'preview environment',
      'deployment',
      'secret scanning',
    ]) {
      expect(readmeLower).toContain(capability);
    }
  });

  it('positions AI auto-setup as the adoption closer', () => {
    expect(readmeLower).toContain('byo-inference');
    expect(readmeLower).toContain('stands the platform up');
  });

  it('keeps a working self-host quickstart', () => {
    expect(readme).toContain('git clone https://github.com/Speakman-ai/agent-hub.git');
    expect(readme).toContain('npm run install:all');
    expect(readme).toContain('npm run dev');
  });

  it('includes rendered architecture diagrams (mermaid)', () => {
    // At least the architecture graph and the DB erDiagram.
    expect(readme).toContain('```mermaid');
    expect(readme).toContain('graph TB');
    expect(readme).toContain('erDiagram');
  });

  it('states the Apache-2.0 open-core license, not proprietary', () => {
    expect(readmeLower).toContain('apache license 2.0');
    expect(readmeLower).toContain('open-core');
    expect(readmeLower).not.toContain('private and proprietary');
  });

  it('documents the control-plane / data-plane split', () => {
    expect(readmeLower).toContain('control-plane / data-plane split');
    expect(readmeLower).toContain('your vpc');
  });
});
