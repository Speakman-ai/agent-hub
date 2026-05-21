import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildComposeBootstrapYaml,
  detectStackHint,
  suggestComposeBootstrap,
} from './preview-compose-bootstrap.js';

describe('preview-compose-bootstrap', () => {
  it('detectStackHint finds vite from package.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-bootstrap-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '5.0.0' }, scripts: { dev: 'vite' } }),
    );
    expect(detectStackHint(dir)).toBe('vite');
  });

  it('suggestComposeBootstrap uses vite port and dev command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-bootstrap-vite-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '5.0.0' }, scripts: { dev: 'vite' } }),
    );
    const s = suggestComposeBootstrap(dir);
    expect(s.entryPort).toBe(5173);
    expect(s.stack).toBe('vite');
    expect(s.composeYaml).toContain('5173:5173');
    expect(s.composeYaml).toContain('npm run dev -- --host 0.0.0.0');
  });

  it('buildComposeBootstrapYaml includes web service', () => {
    const yaml = buildComposeBootstrapYaml('next', 3000, 'npm run dev');
    expect(yaml).toMatch(/^\s+web:/m);
    expect(yaml).toContain('3000:3000');
  });
});
