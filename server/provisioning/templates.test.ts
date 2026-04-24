import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  loadAllTemplates,
  listTemplates,
  listTemplateFiles,
  getTemplate,
  _resetTemplateCache,
  TEMPLATES_ROOT,
} from './templates.js';
import { KNOWN_TEMPLATE_IDS, type TemplateId } from './stack-defaults.js';

/**
 * These tests fulfil the "snapshot test of template tree per stack"
 * acceptance criterion. Rather than relying on vitest snapshot files
 * (which go stale and require --update cycles), we hand-roll a
 * structural assertion for each template: its manifest matches the
 * expected schema, and the files/ tree contains a known, sorted set
 * of paths that include the must-have set called out in the ticket
 * (hello handler/main, one passing unit test, linter config, .gitignore,
 * README.md).
 *
 * Adding a new template? Extend EXPECTED_TREES below alongside the
 * on-disk tree. That's the second step from docs — the first is dropping
 * the template directory under `templates/` and adding its id to
 * `KNOWN_TEMPLATE_IDS`.
 */
const EXPECTED_TREES: Record<TemplateId, string[]> = {
  'typescript-node-tsx': [
    '.gitignore',
    '.prettierrc.json',
    'README.md',
    'eslint.config.mjs',
    'package.json',
    'src/index.test.ts',
    'src/index.ts',
    'tsconfig.json',
  ],
  'python-fastapi-uv': [
    '.gitignore',
    'README.md',
    'app/__init__.py',
    'app/main.py',
    'pyproject.toml',
    'tests/__init__.py',
    'tests/test_main.py',
  ],
  'go-cobra': [
    '.gitignore',
    '.golangci.yml',
    'README.md',
    'cmd/root.go',
    'cmd/root_test.go',
    'go.mod',
    'main.go',
  ],
  'rust-axum': [
    '.gitignore',
    'Cargo.toml',
    'README.md',
    'clippy.toml',
    'src/lib.rs',
    'src/main.rs',
    'tests/hello.rs',
  ],
};

describe('template registry', () => {
  it('loads one manifest per KNOWN_TEMPLATE_IDS entry', () => {
    _resetTemplateCache();
    const all = loadAllTemplates();
    expect([...all.keys()].sort()).toEqual([...KNOWN_TEMPLATE_IDS].sort());
  });

  it('listTemplates() returns templates in KNOWN_TEMPLATE_IDS order', () => {
    _resetTemplateCache();
    const list = listTemplates();
    expect(list.map((t) => t.manifest.id)).toEqual([...KNOWN_TEMPLATE_IDS]);
  });

  it('caches after first load', () => {
    _resetTemplateCache();
    const a = loadAllTemplates();
    const b = loadAllTemplates();
    expect(a).toBe(b); // same Map reference means cache hit
  });

  it('getTemplate throws with a helpful message on unknown ids', () => {
    _resetTemplateCache();
    expect(() => getTemplate('does-not-exist' as TemplateId)).toThrow(
      /Template "does-not-exist" is not registered/,
    );
  });
});

describe.each(KNOWN_TEMPLATE_IDS)('template %s', (id) => {
  _resetTemplateCache();
  const template = getTemplate(id);

  it('manifest matches the declared schema', () => {
    const m = template.manifest;
    expect(m.id).toBe(id);
    expect(typeof m.label).toBe('string');
    expect(m.label.length).toBeGreaterThan(0);
    expect(Array.isArray(m.appTypes)).toBe(true);
    expect(m.appTypes.length).toBeGreaterThan(0);
    expect(Array.isArray(m.setup)).toBe(true);
    expect(m.setup.length).toBeGreaterThan(0);
    expect(typeof m.test).toBe('string');
    expect(m.test.length).toBeGreaterThan(0);
    expect(typeof m.lint).toBe('string');
    expect(m.lint.length).toBeGreaterThan(0);
    expect(Array.isArray(m.recommendedFor)).toBe(true);
  });

  it('files/ tree matches the expected snapshot', () => {
    const actual = listTemplateFiles(template);
    expect(actual).toEqual(EXPECTED_TREES[id]);
  });

  it('manifest.json lives alongside files/ and not inside it', () => {
    const manifestPath = path.join(template.dir, 'manifest.json');
    expect(manifestPath.startsWith(TEMPLATES_ROOT)).toBe(true);
    // Manifest must not leak into the scaffolded project tree.
    expect(listTemplateFiles(template)).not.toContain('manifest.json');
  });

  it('ships a .gitignore and README.md', () => {
    const tree = listTemplateFiles(template);
    expect(tree).toContain('.gitignore');
    expect(tree).toContain('README.md');
  });

  it('.gitignore is non-empty', () => {
    const contents = readFileSync(path.join(template.filesDir, '.gitignore'), 'utf8');
    expect(contents.trim().length).toBeGreaterThan(0);
  });

  it('README.md is non-trivial (at least 100 bytes)', () => {
    const contents = readFileSync(path.join(template.filesDir, 'README.md'), 'utf8');
    expect(contents.length).toBeGreaterThan(100);
  });
});

describe('template requirements (per ticket AC)', () => {
  it('at least four templates are registered', () => {
    expect(KNOWN_TEMPLATE_IDS.length).toBeGreaterThanOrEqual(4);
  });

  it('every ticket-called-out template id is present', () => {
    for (const required of ['python-fastapi-uv', 'typescript-node-tsx', 'go-cobra', 'rust-axum']) {
      expect(KNOWN_TEMPLATE_IDS).toContain(required);
    }
  });

  it('typescript template ships eslint + prettier config', () => {
    const tree = listTemplateFiles(getTemplate('typescript-node-tsx'));
    expect(tree).toContain('eslint.config.mjs');
    expect(tree).toContain('.prettierrc.json');
  });

  it('python template ships ruff config via pyproject.toml', () => {
    const contents = readFileSync(
      path.join(getTemplate('python-fastapi-uv').filesDir, 'pyproject.toml'),
      'utf8',
    );
    expect(contents).toMatch(/\[tool\.ruff\]/);
  });

  it('go template ships a golangci config', () => {
    expect(listTemplateFiles(getTemplate('go-cobra'))).toContain('.golangci.yml');
  });

  it('rust template ships a clippy config', () => {
    expect(listTemplateFiles(getTemplate('rust-axum'))).toContain('clippy.toml');
  });
});
