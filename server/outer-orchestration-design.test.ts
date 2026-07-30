import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, it, expect } from 'vitest';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const docPath = path.join(serverDir, '../docs/architecture/outer-orchestration-plan-act-verify.md');

describe('outer orchestration design (docs/architecture)', () => {
  it('defines PAV phases, stop rules, and implementation phasing', () => {
    const md = readFileSync(docPath, 'utf8');
    expect(md).toMatch(/Plan.{0,80}Act.{0,80}Verify/i);
    expect(md).toContain('Implementation phasing');
    expect(md).toMatch(/P0|P1/);
    expect(md).toContain('controlFlowPresent');
  });
});
