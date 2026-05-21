import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  detectPreviewSuggestion,
  previewDetectSuggestionToJson,
} from './preview-detect-suggestion.js';

describe('detectPreviewSuggestion', () => {
  it('prefers compose when docker-compose.yml exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-compose-'));
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      ['services:', '  web:', '    ports:', '      - "3000:3000"'].join('\n'),
    );
    const got = detectPreviewSuggestion(dir);
    expect(got?.mode).toBe('compose');
    if (got?.mode === 'compose') {
      expect(got.compose.entryService).toBe('web');
      expect(got.compose.entryPort).toBe(3000);
    }
  });

  it('returns script mode for a simple vite package.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-vite-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { vite: '5.0.0' },
        scripts: { dev: 'vite' },
      }),
    );
    const got = detectPreviewSuggestion(dir);
    expect(got?.mode).toBe('script');
    if (got?.mode === 'script') {
      expect(got.startScript).toMatch(/npm run dev/);
    }
  });

  it('serializes processes in detect JSON for multi-process stacks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-fs-'));
    mkdirSync(path.join(dir, 'backend'), { recursive: true });
    mkdirSync(path.join(dir, 'frontend'), { recursive: true });
    writeFileSync(path.join(dir, 'backend', 'manage.py'), '');
    writeFileSync(
      path.join(dir, 'frontend', 'package.json'),
      JSON.stringify({ dependencies: { vite: '5' }, scripts: { dev: 'vite' } }),
    );
    const got = detectPreviewSuggestion(dir);
    if (got?.mode === 'multi-process') {
      const json = previewDetectSuggestionToJson(got);
      expect(Array.isArray(json.detected?.processes)).toBe(true);
      expect((json.detected?.processes as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
