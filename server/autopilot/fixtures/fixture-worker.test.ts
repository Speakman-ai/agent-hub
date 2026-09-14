import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-worker.mjs');

function runWorker(prompt: string): string {
  return execFileSync(process.execPath, [WORKER, '-p', prompt], {
    encoding: 'utf8',
    cwd: path.dirname(WORKER),
  });
}

describe('autopilot fixture worker', () => {
  it('emits an approved review-verdict when the prompt asks for one', () => {
    const stdout = runWorker('End THIS turn with the <agenthub:review-verdict> block.');
    expect(stdout).toContain('<agenthub:review-verdict>');
    expect(stdout).toContain('\\"verdict\\":\\"approved\\"');
    expect(stdout).not.toContain('Committed complete-todo');
  });

  it('emits the baseline spec for a planning prompt', () => {
    const stdout = runWorker('Return ONLY a fenced JSON object.');
    expect(stdout).toContain('acceptanceJourneys');
    expect(stdout).not.toContain('review-verdict');
  });
});
