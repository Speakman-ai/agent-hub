import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  selectNodePtyDonor,
  nodePtyDonorCandidates,
  nodePtyLoads,
  healNodePty,
  copyNodePtyModule,
  NODE_PTY_MODULE_REL,
} from '../scripts/ensure-native-modules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..'); // has package.json

/** Marker file a "built" node-pty donor carries; presence == "loads". */
const BUILT_MARKER = path.join('build', 'Release', 'pty.node');

/** Create a fake node-pty module dir (optionally "built") under `base`. */
function makeModule(base, name, { built } = { built: true }) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'node-pty' }));
  fs.writeFileSync(path.join(dir, 'index.js'), '// fake');
  if (built) {
    fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(dir, BUILT_MARKER), 'ELF-ish bytes');
  }
  return dir;
}

/** A donor/target "loads" iff it carries the built marker. */
const loadsByMarker = (dir) => fs.existsSync(path.join(dir, BUILT_MARKER));

describe('selectNodePtyDonor', () => {
  it('returns the first donor that probes true', () => {
    const seen = [];
    const donor = selectNodePtyDonor(['/a', '/b', '/c'], (d) => {
      seen.push(d);
      return d === '/b';
    });
    expect(donor).toBe('/b');
    // short-circuits: never probes '/c'
    expect(seen).toEqual(['/a', '/b']);
  });

  it('returns null when no donor probes true', () => {
    expect(selectNodePtyDonor(['/a', '/b'], () => false)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(selectNodePtyDonor([], () => true)).toBeNull();
  });
});

describe('nodePtyDonorCandidates', () => {
  it('always includes the /app image copy', () => {
    const cands = nodePtyDonorCandidates({});
    expect(cands).toContain(path.join('/app', 'server', NODE_PTY_MODULE_REL));
  });

  it('puts an explicit AGENT_HUB_NODE_PTY_DONOR override first', () => {
    const cands = nodePtyDonorCandidates({ AGENT_HUB_NODE_PTY_DONOR: '/custom/node-pty' });
    expect(cands[0]).toBe('/custom/node-pty');
    expect(cands).toContain(path.join('/app', 'server', NODE_PTY_MODULE_REL));
  });
});

describe('nodePtyLoads', () => {
  it('is false for a dir without a package.json (no probe spawned)', () => {
    let ran = false;
    const run = () => {
      ran = true;
      return { status: 0 };
    };
    expect(nodePtyLoads('/definitely/not/here', run)).toBe(false);
    expect(ran).toBe(false);
  });

  it('is false for an empty/undefined dir', () => {
    expect(nodePtyLoads('', () => ({ status: 0 }))).toBe(false);
    expect(nodePtyLoads(undefined, () => ({ status: 0 }))).toBe(false);
  });

  it('reflects the child probe exit status when a package.json exists', () => {
    // repoRoot has a package.json, so the existence gate passes and the
    // injected probe decides the result.
    expect(nodePtyLoads(repoRoot, () => ({ status: 0 }))).toBe(true);
    expect(nodePtyLoads(repoRoot, () => ({ status: 1 }))).toBe(false);
    expect(nodePtyLoads(repoRoot, () => null)).toBe(false);
  });
});

describe('healNodePty (workflow)', () => {
  let tmp;
  let logs;
  const log = (msg) => logs.push(String(msg));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahub-node-pty-heal-'));
    logs = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies a compatible donor into a missing target and reports success', () => {
    const donor = makeModule(tmp, 'donor', { built: true });
    const target = path.join(tmp, 'server', 'node_modules', 'node-pty'); // does not exist yet

    const healed = healNodePty({ target, candidates: [donor], loads: loadsByMarker, log });

    expect(healed).toBe(true);
    // The real recursive copy ran: the built marker now exists in the target.
    expect(fs.existsSync(path.join(target, BUILT_MARKER))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).toContain('node-pty');
    expect(logs.join('\n')).toContain('Healed node-pty');
  });

  it('replaces an unusable existing target with the donor build', () => {
    // Target exists but is NOT built (no marker) → treated as unusable.
    const target = makeModule(path.join(tmp, 'server', 'node_modules'), 'node-pty', {
      built: false,
    });
    const donor = makeModule(tmp, 'donor', { built: true });

    const healed = healNodePty({ target, candidates: [donor], loads: loadsByMarker, log });

    expect(healed).toBe(true);
    expect(fs.existsSync(path.join(target, BUILT_MARKER))).toBe(true);
  });

  it('is a no-op when the target already loads (donor never copied)', () => {
    const target = makeModule(path.join(tmp, 'server', 'node_modules'), 'node-pty', {
      built: true,
    });
    let copied = false;
    const healed = healNodePty({
      target,
      candidates: [makeModule(tmp, 'donor', { built: true })],
      loads: loadsByMarker,
      copyModule: () => {
        copied = true;
      },
      log,
    });

    expect(healed).toBe(false);
    expect(copied).toBe(false);
    expect(logs).toEqual([]);
  });

  it('degrades non-fatally when no donor is usable (nothing written)', () => {
    const target = path.join(tmp, 'server', 'node_modules', 'node-pty');
    const badDonor = makeModule(tmp, 'donor', { built: false }); // won't "load"

    const healed = healNodePty({ target, candidates: [badDonor], loads: loadsByMarker, log });

    expect(healed).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(logs.join('\n')).toContain('no ABI-compatible prebuilt donor');
  });

  it('degrades non-fatally when the copy throws', () => {
    const donor = makeModule(tmp, 'donor', { built: true });
    const target = path.join(tmp, 'server', 'node_modules', 'node-pty');

    const healed = healNodePty({
      target,
      candidates: [donor],
      loads: loadsByMarker,
      copyModule: () => {
        throw new Error('ENOSPC: disk full');
      },
      log,
    });

    expect(healed).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(logs.join('\n')).toContain('Failed to copy node-pty');
    expect(logs.join('\n')).toContain('ENOSPC');
  });

  it('reports non-fatally when the copied module still fails to load', () => {
    const donor = makeModule(tmp, 'donor', { built: true });
    const target = path.join(tmp, 'server', 'node_modules', 'node-pty');
    // Copy succeeds, but the post-copy validation never sees a working module.
    const loads = (dir) => dir === donor;

    const healed = healNodePty({ target, candidates: [donor], loads, log });

    expect(healed).toBe(false);
    // The copy still ran (donor was the chosen source)…
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    // …but heal reports the load failure rather than claiming success.
    expect(logs.join('\n')).toContain('still fails to load');
  });

  it('excludes the target itself from the donor candidates', () => {
    const target = makeModule(path.join(tmp, 'server', 'node_modules'), 'node-pty', {
      built: false,
    });
    // Only candidate is the target → after self-filter there are no donors.
    const healed = healNodePty({ target, candidates: [target], loads: loadsByMarker, log });

    expect(healed).toBe(false);
    expect(logs.join('\n')).toContain('no ABI-compatible prebuilt donor');
  });
});

describe('copyNodePtyModule', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahub-node-pty-copy-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recursively copies the donor tree, replacing any existing target', () => {
    const donor = makeModule(tmp, 'donor', { built: true });
    const target = makeModule(path.join(tmp, 'nested'), 'node-pty', { built: false });
    // Stale file that must not survive the replace.
    fs.writeFileSync(path.join(target, 'stale.txt'), 'old');

    copyNodePtyModule(donor, target);

    expect(fs.existsSync(path.join(target, BUILT_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false);
  });
});
