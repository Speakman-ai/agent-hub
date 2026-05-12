/**
 * Functional coverage for the `scan-env-usage.sh` helper bundled with
 * the preview-setup wizard skill. The wizard shells out to this script
 * to enumerate env keys the project's source code reads, so the
 * SKILL.md can build a `agenthub:ask` block asking the user to confirm
 * which keys are required.
 *
 * We invoke the shell script via execFileSync against a tmp workspace
 * to validate the exact same code path the wizard runs.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(
  __dirname,
  '..',
  'default-skills',
  'preview-setup',
  'scripts',
  'scan-env-usage.sh',
);

function run(dir: string): string[] {
  const out = execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.length > 0);
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'preview-setup-scan-'));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('scan-env-usage.sh', () => {
  it('returns empty output for a non-existent directory', () => {
    expect(run(path.join(scratch, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty output for an empty workspace', () => {
    expect(run(scratch)).toEqual([]);
  });

  it('finds process.env.FOO and import.meta.env.VITE_BAR and dedupes', () => {
    mkdirSync(path.join(scratch, 'src'), { recursive: true });
    writeFileSync(
      path.join(scratch, 'src', 'a.js'),
      [
        'const a = process.env.FOO;',
        'const b = process.env.FOO; // dup on purpose',
        'const c = process.env["BAR"];',
        'const d = import.meta.env.VITE_BAZ;',
      ].join('\n'),
    );
    const found = run(scratch);
    expect(found).toContain('FOO');
    expect(found).toContain('BAR');
    expect(found).toContain('VITE_BAZ');
    // Dedup: FOO appears only once in output.
    expect(found.filter((k) => k === 'FOO')).toHaveLength(1);
  });

  it('finds Python os.environ patterns', () => {
    mkdirSync(path.join(scratch, 'backend'), { recursive: true });
    writeFileSync(
      path.join(scratch, 'backend', 'app.py'),
      [
        'import os',
        "STRIPE = os.environ['STRIPE_KEY']",
        "TOKEN = os.environ.get('TOKEN_X')",
        'PORT = os.environ.get("PORT_OVERRIDE")',
      ].join('\n'),
    );
    const found = run(scratch);
    expect(found).toContain('STRIPE_KEY');
    expect(found).toContain('TOKEN_X');
    expect(found).toContain('PORT_OVERRIDE');
  });

  it('skips node_modules and .git', () => {
    mkdirSync(path.join(scratch, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(
      path.join(scratch, 'node_modules', 'foo', 'index.js'),
      'const x = process.env.NOISE_FROM_DEPS;',
    );
    mkdirSync(path.join(scratch, '.git'), { recursive: true });
    writeFileSync(path.join(scratch, '.git', 'hooks.js'), 'const y = process.env.GIT_HOOK_NOISE;');
    // Add a legit signal so we know the script didn't bail early.
    mkdirSync(path.join(scratch, 'src'), { recursive: true });
    writeFileSync(path.join(scratch, 'src', 'main.ts'), 'const ok = process.env.REAL_KEY;');
    const found = run(scratch);
    expect(found).toContain('REAL_KEY');
    expect(found).not.toContain('NOISE_FROM_DEPS');
    expect(found).not.toContain('GIT_HOOK_NOISE');
  });

  it('output is sorted', () => {
    mkdirSync(path.join(scratch, 'src'), { recursive: true });
    writeFileSync(
      path.join(scratch, 'src', 'a.js'),
      [
        'const a = process.env.ZED;',
        'const b = process.env.ALPHA;',
        'const c = process.env.MIDDLE;',
      ].join('\n'),
    );
    const found = run(scratch);
    const sortedCopy = [...found].sort();
    expect(found).toEqual(sortedCopy);
  });
});
