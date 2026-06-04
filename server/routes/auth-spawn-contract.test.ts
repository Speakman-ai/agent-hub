import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guardrail: CLI auth helpers spawn with `detached: true` and use an explicit
 * `setTimeout(() => killProcessGroup(proc, 'SIGTERM'), …)` for per-run limits.
 * Relying on `spawn({ timeout })` alone signals only the direct child and can
 * leave grandchildren orphaned when nested CLIs spawn subshells.
 */
const routesDir = path.dirname(fileURLToPath(import.meta.url));

function readRoute(name: string): string {
  return readFileSync(path.join(routesDir, name), 'utf8');
}

describe('auth CLI spawn — process-group timeout', () => {
  // claude-auth / codex-auth / cursor-auth global routes were removed —
  // those engines authenticate strictly per-account now. Gemini remains the
  // one host-configured CLI auth route.
  it('gemini-auth uses killProcessGroup timer, not spawn timeout', () => {
    const src = readRoute('gemini-auth.ts');
    expect(src).toMatch(/setTimeout\(\(\)\s*=>\s*killProcessGroup\(proc,\s*'SIGTERM'\)/);
    expect(src).not.toMatch(/spawn\([\s\S]*?timeout:\s*opts\.timeout/s);
  });
});
