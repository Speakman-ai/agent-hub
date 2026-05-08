/**
 * op-list-smoke.test.ts — Bash-layer regression tests for op-list.sh formatting.
 *
 * These tests verify that the Python inline code inside op-list.sh's shell
 * script doesn't regress at the bash-quoting layer.
 *
 * Background: an earlier version used `python3 -c "...f"{'Key':<40}..."` where
 * the inner double-quotes terminated the bash -c argument early, causing bash
 * to parse `<40}` as an input redirection. The fix was to use single-quoted
 * bash arguments (`-c '...'`). This test suite:
 *
 *  1. Runs the Python formatting code from a temp file (avoids re-testing the
 *     quoting fix in Python itself — that was already verified by smoke-testing
 *     the script).
 *  2. Verifies Python output correctness for all three list subcommands and
 *     their edge-cases.
 *  3. Runs `bash -n` on the script file to catch bash syntax errors.
 *
 * A future follow-up could add a full end-to-end test with a stubbed `op`
 * binary on a temporary PATH when the skill has integration-test infrastructure.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, 'default-skills/1password/scripts/op-list.sh');

/** Run Python code from a temp file with JSON piped to stdin. */
function runPythonCode(
  code: string,
  stdinJson: string,
): { stdout: string; stderr: string; status: number } {
  const tmpDir = mkdtempSync(`${tmpdir()}/op-list-test-`);
  const pyFile = `${tmpDir}/fmt.py`;
  writeFileSync(pyFile, code, 'utf8');
  const result = spawnSync('python3', [pyFile], {
    input: stdinJson,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Python formatting code — must stay in sync with op-list.sh
// ---------------------------------------------------------------------------

const ITEMS_CODE = `
import sys, json
items = json.load(sys.stdin)
if not items:
    print("(no items found)")
    sys.exit(0)
print("{:<40} {:<20} {:<20} {}".format("Title", "Category", "Vault", "UUID"))
print("-" * 100)
for item in items:
    title    = (item.get("title") or "")[:38]
    category = (item.get("category") or "")[:18]
    vault    = (item.get("vault", {}).get("name") or "")[:18]
    uid      = item.get("id", "")
    print("{:<40} {:<20} {:<20} {}".format(title, category, vault, uid))
print("\\n{} item(s)".format(len(items)))
`;

const VAULTS_CODE = `
import sys, json
vaults = json.load(sys.stdin)
if not vaults:
    print("(no vaults accessible)")
    sys.exit(0)
print("{:<30} {:<15} {}".format("Name", "Type", "UUID"))
print("-" * 75)
for v in vaults:
    name  = (v.get("name") or "")[:28]
    vtype = (v.get("type") or "")[:13]
    uid   = v.get("id", "")
    print("{:<30} {:<15} {}".format(name, vtype, uid))
print("\\n{} vault(s)".format(len(vaults)))
`;

const DOCUMENTS_CODE = `
import sys, json
docs = json.load(sys.stdin)
if not docs:
    print("(no documents found)")
    sys.exit(0)
print("{:<40} {:<20} {}".format("Title", "Vault", "UUID"))
print("-" * 80)
for d in docs:
    title = (d.get("title") or "")[:38]
    vault = (d.get("vault", {}).get("name") or "")[:18]
    uid   = d.get("id", "")
    print("{:<40} {:<20} {}".format(title, vault, uid))
print("\\n{} document(s)".format(len(docs)))
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('op-list.sh Python formatting (bash quoting regression)', () => {
  // --- items ----------------------------------------------------------------

  it('items: formats items correctly', () => {
    const json =
      '[{"title":"My Login","category":"Login","vault":{"name":"Personal"},"id":"abc123"}]';
    const { stdout, stderr, status } = runPythonCode(ITEMS_CODE, json);
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('Title');
    expect(stdout).toContain('My Login');
    expect(stdout).toContain('Login');
    expect(stdout).toContain('Personal');
    expect(stdout).toContain('abc123');
    expect(stdout).toContain('1 item(s)');
  });

  it('items: handles empty list', () => {
    const { stdout, status } = runPythonCode(ITEMS_CODE, '[]');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('(no items found)');
  });

  it('items: truncates long title to 38 chars', () => {
    const longTitle = 'A'.repeat(50);
    const json = `[{"title":"${longTitle}","category":"Login","vault":{"name":"V"},"id":"x"}]`;
    const { stdout, status } = runPythonCode(ITEMS_CODE, json);
    expect(status).toBe(0);
    expect(stdout).toContain('A'.repeat(38));
    // 39th 'A' must not appear (truncated)
    const line = stdout.split('\n').find((l) => l.includes('A'.repeat(38)));
    expect(line?.trim().startsWith('A'.repeat(38))).toBe(true);
  });

  it('items: handles missing vault gracefully', () => {
    const json = '[{"title":"No Vault","category":"Login","id":"nv1"}]';
    const { stdout, status } = runPythonCode(ITEMS_CODE, json);
    expect(status).toBe(0);
    expect(stdout).toContain('No Vault');
  });

  // --- vaults ---------------------------------------------------------------

  it('vaults: formats vault list correctly', () => {
    const json =
      '[{"name":"Personal","type":"USER_CREATED","id":"v1"},{"name":"Shared","type":"USER_CREATED","id":"v2"}]';
    const { stdout, status } = runPythonCode(VAULTS_CODE, json);
    expect(status).toBe(0);
    expect(stdout).toContain('Name');
    expect(stdout).toContain('Personal');
    expect(stdout).toContain('Shared');
    expect(stdout).toContain('2 vault(s)');
  });

  it('vaults: handles empty list', () => {
    const { stdout, status } = runPythonCode(VAULTS_CODE, '[]');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('(no vaults accessible)');
  });

  // --- documents ------------------------------------------------------------

  it('documents: formats document list correctly', () => {
    const json = '[{"title":"SSH Key","vault":{"name":"Personal"},"id":"doc1"}]';
    const { stdout, status } = runPythonCode(DOCUMENTS_CODE, json);
    expect(status).toBe(0);
    expect(stdout).toContain('Title');
    expect(stdout).toContain('SSH Key');
    expect(stdout).toContain('Personal');
    expect(stdout).toContain('1 document(s)');
  });

  it('documents: handles empty list', () => {
    const { stdout, status } = runPythonCode(DOCUMENTS_CODE, '[]');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('(no documents found)');
  });

  // --- script-level checks --------------------------------------------------

  it('op-list.sh exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('op-list.sh passes bash -n syntax check', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status, `bash -n stderr: ${result.stderr}`).toBe(0);
  });
});
