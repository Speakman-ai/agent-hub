import { describe, it, expect } from 'vitest';
import { appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';

describe('appendCodexExecSandboxFlags', () => {
  it('uses read-only sandbox in ask mode regardless of dangerBypass', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, { askMode: true, dangerBypass: true });
    expect(a).toEqual(['exec', '--json', '--sandbox', 'read-only']);
  });

  it('uses full bypass when not ask mode and dangerBypass', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, { askMode: false, dangerBypass: true });
    expect(a).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('uses --full-auto when not ask mode and not dangerBypass', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, { askMode: false, dangerBypass: false });
    expect(a).toEqual(['exec', '--json', '--full-auto']);
  });
});
