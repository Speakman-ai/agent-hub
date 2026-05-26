import { describe, it, expect } from 'vitest';
import { appendCodexAwsAccessDirs, appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';

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

  it('uses --full-auto when not ask mode and not dangerBypass and no AWS profiles', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, { askMode: false, dangerBypass: false });
    expect(a).toEqual(['exec', '--json', '--full-auto']);
  });

  it('uses danger-full-access + network when AWS SSO profiles are configured and dangerBypass is off', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, {
      askMode: false,
      dangerBypass: false,
      awsSsoEnabled: true,
    });
    expect(a).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
  });

  it('dangerBypass wins over awsSsoEnabled', () => {
    const a: string[] = ['exec', '--json'];
    appendCodexExecSandboxFlags(a, {
      askMode: false,
      dangerBypass: true,
      awsSsoEnabled: true,
    });
    expect(a).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('appendCodexAwsAccessDirs', () => {
  it('adds --add-dir for AWS_CONFIG_FILE parent and HOME/.aws', () => {
    const a: string[] = ['exec'];
    appendCodexAwsAccessDirs(a, {
      HOME: '/data/per-user-creds/u1/home',
      AWS_CONFIG_FILE: '/data/project-aws-config/proj/config',
    });
    expect(a).toEqual([
      'exec',
      '--add-dir',
      '/data/project-aws-config/proj',
      '--add-dir',
      '/data/per-user-creds/u1/home/.aws',
    ]);
  });

  it('is a no-op when HOME and AWS_CONFIG_FILE are unset', () => {
    const a: string[] = ['exec'];
    appendCodexAwsAccessDirs(a, { HOME: undefined, AWS_CONFIG_FILE: undefined });
    expect(a).toEqual(['exec']);
  });
});
