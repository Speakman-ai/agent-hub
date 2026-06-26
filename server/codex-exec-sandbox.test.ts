import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import {
  appendCodexAwsAccessDirs,
  appendCodexExecSandboxFlags,
  appendCodexShellEnvironmentPolicyArgs,
} from './codex-exec-sandbox.js';

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
    expect(a).toEqual(['exec', '--json', '--sandbox', 'danger-full-access']);
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
  it('does not emit --add-dir (invalid on codex exec resume)', () => {
    const a: string[] = ['exec'];
    appendCodexAwsAccessDirs(a, {
      HOME: '/data/per-user-creds/u1/home',
      AWS_CONFIG_FILE: '/data/project-aws-config/proj/config',
    });
    expect(a).toEqual(['exec']);
    expect(a.filter((x) => x === '--add-dir')).toHaveLength(0);
  });

  it('is a no-op when HOME and AWS_CONFIG_FILE are unset', () => {
    const a: string[] = ['exec'];
    appendCodexAwsAccessDirs(a, { HOME: undefined, AWS_CONFIG_FILE: undefined });
    expect(a).toEqual(['exec']);
  });
});

describe('appendCodexShellEnvironmentPolicyArgs', () => {
  it('forces Codex tool subprocess PATH to include Agent Hub skill wrappers', () => {
    const args: string[] = ['exec', '--json'];
    appendCodexShellEnvironmentPolicyArgs(args, {
      PATH: '/app/server/default-skills/agent-hub/scripts:/usr/local/bin:/usr/bin',
      AGENT_HUB_SKILLS_DIR: '/app/server/default-skills/agent-hub',
    });

    expect(args).toContain('-c');
    expect(args).toContain(
      'shell_environment_policy.set.PATH="/app/server/default-skills/agent-hub/scripts:/usr/local/bin:/usr/bin"',
    );
    expect(args).toContain(
      'shell_environment_policy.set.AGENT_HUB_SKILLS_DIR="/app/server/default-skills/agent-hub"',
    );
  });

  it('does not copy Agent Hub API keys into argv config', () => {
    const args: string[] = ['exec'];
    appendCodexShellEnvironmentPolicyArgs(args, {
      PATH: '/usr/bin',
      AGENT_HUB_SKILLS_DIR: '/skills',
      AGENT_HUB_API_KEY: 'secret',
    } as NodeJS.ProcessEnv);

    expect(args.join('\n')).not.toContain('AGENT_HUB_API_KEY');
    expect(args.join('\n')).not.toContain('secret');
  });
});

/** Mirrors chat.ts codex resume argv assembly (session-87ecfed2 regression). */
function buildCodexChatResumeArgv(
  engineSessionId: string,
  opts: { dangerBypass: boolean },
): string[] {
  const args: string[] = ['exec', 'resume', engineSessionId, '--json', '--skip-git-repo-check'];
  appendCodexExecSandboxFlags(args, {
    askMode: false,
    dangerBypass: opts.dangerBypass,
    awsSsoEnabled: true,
  });
  appendCodexAwsAccessDirs(args, {
    HOME: '/data/per-user-creds/u1/home',
    AWS_CONFIG_FILE: '/data/project-aws-config/agent-hub/config',
  });
  appendCodexShellEnvironmentPolicyArgs(args, {
    PATH: '/app/server/default-skills/agent-hub/scripts:/usr/bin',
    AGENT_HUB_SKILLS_DIR: '/app/server/default-skills/agent-hub',
  });
  args.push('-');
  return args;
}

describe('codex exec resume + AWS (regression)', () => {
  it('resume argv with AWS dirs contains no --add-dir', () => {
    const argv = buildCodexChatResumeArgv('thread-abc', { dangerBypass: true });
    expect(argv).not.toContain('--add-dir');
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('resume');
    expect(argv).toContain(
      'shell_environment_policy.set.PATH="/app/server/default-skills/agent-hub/scripts:/usr/bin"',
    );
  });

  it('mocked codex wrapper exits 0 for resume argv (not 2 from clap)', () => {
    const argv = buildCodexChatResumeArgv('thread-abc', { dangerBypass: true });
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const bad = process.argv.includes('--add-dir');
         process.exit(bad ? 2 : 0);`,
        '--',
        ...argv,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
