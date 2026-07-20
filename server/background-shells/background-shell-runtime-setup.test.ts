import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailLines } from './background-shell-runtime-setup.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readTailLines', () => {
  it('reads only the requested tail from a large persisted log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-hub-bg-log-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'shell.log');
    const lines = Array.from({ length: 20_000 }, (_, index) => `line-${index}`);
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    expect(readTailLines(logPath, 3)).toEqual(['line-19997', 'line-19998', 'line-19999']);
    expect(readTailLines(logPath, 0)).toEqual([]);
  });
});
