import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  createDesign,
  listDesigns,
  getDesign,
  renameDesign,
  setDesignAgentModel,
  setLinkedProjects,
  linkProject,
  unlinkProject,
  deleteDesign,
  appendDesignMessage,
  listDesignMessages,
  listDesignFiles,
  ensureDesignsRoot,
  designDir,
} from './designs-store.js';
import { getDb } from './db.js';
import { wipeTables } from './test/destructive-db.js';
import type { Project } from './types.js';

// Each test gets its own designs root on disk and a clean slate in the
// shared test DB (the DB is initialized once by test/setup.ts via the
// AGENT_HUB_DATA_DIR env var).
let designsRoot: string;

const projects = new Map<string, Project>();
function lookup(id: string): Project | null {
  return projects.get(id) ?? null;
}

function registerProject(id: string, overrides: Partial<Project> = {}): Project {
  const p: Project = {
    id,
    name: overrides.name ?? `Project ${id}`,
    cwd: overrides.cwd ?? '/tmp',
    ahw: overrides.ahw ?? '/tmp',
    color: overrides.color,
    agents: [],
    ...overrides,
  };
  projects.set(id, p);
  return p;
}

beforeEach(() => {
  designsRoot = mkdtempSync(path.join(tmpdir(), 'designs-store-test-'));
  ensureDesignsRoot(designsRoot);

  // Wipe the three design tables between tests so rows don't leak across
  // test files that share the setup.ts DB.
  const db = getDb();
  // wipeTables enforces the scratch-DB check (server/test/destructive-db.ts)
  // — the successor to the inline guard added after the designs-wipe incident
  // (see PR feature/designs-wipe-guard).
  wipeTables(db, ['design_messages', 'design_projects', 'designs']);
  projects.clear();
});

describe('designs-store — CRUD', () => {
  it('creates a design, seeds index.html on disk, and returns linked projects', () => {
    registerProject('proj-a', { name: 'Alpha' });
    registerProject('proj-b', { name: 'Beta' });

    const design = createDesign('Dashboard', ['proj-a', 'proj-b'], designsRoot, lookup);

    expect(design.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(design.name).toBe('Dashboard');
    expect(design.linkedProjects.map((p) => p.id).sort()).toEqual(['proj-a', 'proj-b']);

    const dir = designDir(designsRoot, design.id);
    expect(existsSync(dir)).toBe(true);
    const seed = readFileSync(path.join(dir, 'index.html'), 'utf-8');
    expect(seed).toContain('<!doctype html>');
    expect(seed).toContain('<body>');
  });

  it('rejects empty or whitespace-only names', () => {
    expect(() => createDesign('', [], designsRoot, lookup)).toThrow(/name is required/i);
    expect(() => createDesign('   ', [], designsRoot, lookup)).toThrow(/name is required/i);
  });

  it('lists designs in updated_at DESC order', () => {
    const first = createDesign('First', [], designsRoot, lookup);
    // Force updated_at on the second row to be strictly newer.
    getDb()
      .prepare("UPDATE designs SET updated_at = datetime('now', '-1 hour') WHERE id = ?")
      .run(first.id);
    const second = createDesign('Second', [], designsRoot, lookup);

    const rows = listDesigns(lookup);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('getDesign returns null for missing rows', () => {
    expect(getDesign('does-not-exist', lookup)).toBeNull();
  });

  it('renameDesign updates the name and rejects empty values', () => {
    const design = createDesign('Old', [], designsRoot, lookup);
    renameDesign(design.id, 'New');
    expect(getDesign(design.id, lookup)?.name).toBe('New');
    expect(() => renameDesign(design.id, '  ')).toThrow(/name is required/i);
  });

  it('setDesignAgentModel persists agent_model on the design row', () => {
    const design = createDesign('M', [], designsRoot, lookup);
    expect(getDesign(design.id, lookup)?.agent_model).toBeNull();
    setDesignAgentModel(design.id, 'claude-sonnet-4-6');
    expect(getDesign(design.id, lookup)?.agent_model).toBe('claude-sonnet-4-6');
    setDesignAgentModel(design.id, null);
    expect(getDesign(design.id, lookup)?.agent_model).toBeNull();
  });

  it('drops unknown project ids silently from the hydrated output', () => {
    registerProject('known');
    const design = createDesign('X', ['known', 'ghost'], designsRoot, lookup);
    const fetched = getDesign(design.id, lookup)!;
    expect(fetched.linkedProjects.map((p) => p.id)).toEqual(['known']);
  });
});

describe('designs-store — project links', () => {
  it('setLinkedProjects replaces the entire link set', () => {
    registerProject('a');
    registerProject('b');
    registerProject('c');
    const d = createDesign('X', ['a', 'b'], designsRoot, lookup);

    setLinkedProjects(d.id, ['b', 'c']);
    const links = getDesign(d.id, lookup)!
      .linkedProjects.map((p) => p.id)
      .sort();
    expect(links).toEqual(['b', 'c']);
  });

  it('linkProject is idempotent', () => {
    registerProject('a');
    const d = createDesign('X', [], designsRoot, lookup);
    linkProject(d.id, 'a');
    linkProject(d.id, 'a');
    expect(getDesign(d.id, lookup)!.linkedProjects).toHaveLength(1);
  });

  it('unlinkProject is a no-op for absent links', () => {
    registerProject('a');
    const d = createDesign('X', ['a'], designsRoot, lookup);
    unlinkProject(d.id, 'a');
    unlinkProject(d.id, 'a'); // already gone
    expect(getDesign(d.id, lookup)!.linkedProjects).toHaveLength(0);
  });
});

describe('designs-store — messages', () => {
  it('appends messages in order and lists them chronologically', () => {
    const d = createDesign('X', [], designsRoot, lookup);
    appendDesignMessage(d.id, 'user', 'hi');
    appendDesignMessage(d.id, 'assistant', 'hello');
    appendDesignMessage(d.id, 'system', 'note');

    const msgs = listDesignMessages(d.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
      ['system', 'note'],
    ]);
  });

  it('appending a message touches updated_at', () => {
    const d = createDesign('X', [], designsRoot, lookup);
    // Backdate the row so the touch is visibly later.
    getDb().prepare("UPDATE designs SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(d.id);
    appendDesignMessage(d.id, 'user', 'bump');
    const after = getDesign(d.id, lookup)!;
    expect(after.updated_at).not.toBe('2020-01-01 00:00:00');
  });
});

describe('designs-store — delete cascade + artifact wipe', () => {
  it('deleteDesign cascades to links + messages and removes the dir', () => {
    registerProject('a');
    const d = createDesign('X', ['a'], designsRoot, lookup);
    appendDesignMessage(d.id, 'user', 'stuck');
    // Drop a stray file in the dir so we can confirm the whole tree is nuked.
    writeFileSync(path.join(designDir(designsRoot, d.id), 'styles.css'), '/* */');

    deleteDesign(d.id, designsRoot);

    expect(getDesign(d.id, lookup)).toBeNull();
    const db = getDb();
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM design_projects WHERE design_id = ?').get(d.id) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM design_messages WHERE design_id = ?').get(d.id) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(existsSync(designDir(designsRoot, d.id))).toBe(false);
  });

  it('deleteDesign tolerates an already-missing artifact dir', () => {
    const d = createDesign('X', [], designsRoot, lookup);
    // Simulate an out-of-band rmdir.
    const dir = designDir(designsRoot, d.id);
    rmSync(dir, { recursive: true, force: true });
    expect(() => deleteDesign(d.id, designsRoot)).not.toThrow();
    expect(getDesign(d.id, lookup)).toBeNull();
  });
});

describe('designs-store — cross-org isolation', () => {
  it('listDesigns only returns designs belonging to the requested org', () => {
    const dA = createDesign('Org A design', [], designsRoot, lookup, 'org-a');
    const dB = createDesign('Org B design', [], designsRoot, lookup, 'org-b');

    const listA = listDesigns(lookup, 'org-a');
    const listB = listDesigns(lookup, 'org-b');

    expect(listA.map((d) => d.id)).toEqual([dA.id]);
    expect(listB.map((d) => d.id)).toEqual([dB.id]);
  });

  it('getDesign returns null when orgId does not match', () => {
    const d = createDesign('Scoped', [], designsRoot, lookup, 'org-a');

    expect(getDesign(d.id, lookup, 'org-a')).not.toBeNull();
    expect(getDesign(d.id, lookup, 'org-b')).toBeNull();
  });

  it('getDesign without orgId returns the design regardless of org (backwards compat)', () => {
    const d = createDesign('Unscoped', [], designsRoot, lookup, 'org-x');
    expect(getDesign(d.id, lookup)).not.toBeNull();
  });
});

describe('designs-store — listDesignFiles', () => {
  it('returns a sorted list of files in the artifact dir', () => {
    const d = createDesign('X', [], designsRoot, lookup);
    const dir = designDir(designsRoot, d.id);
    writeFileSync(path.join(dir, 'app.js'), '');
    writeFileSync(path.join(dir, 'styles.css'), '');

    const files = listDesignFiles(designsRoot, d.id);
    expect(files).toEqual(['app.js', 'index.html', 'styles.css']);
  });

  it('returns [] for a design with no dir on disk', () => {
    expect(listDesignFiles(designsRoot, 'never-created')).toEqual([]);
  });
});
