import { describe, it, expect } from 'vitest';
import {
  adaptSpawnEnvForGuest,
  buildGuestCliCommand,
  finalizeGuestSpawnEnv,
  guestEngineBinCandidates,
  GUEST_CLI_HOME,
  GUEST_RUNTIME_ROOT,
  GUEST_SKILLS_ROOT,
  GUEST_SPAWN_GUARDS_DIR,
  hostCwdToWorktreeRelative,
  shellQuote,
} from './guest-cli-spawn.js';

describe('shellQuote / buildGuestCliCommand', () => {
  it('quotes args for sh -c', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildGuestCliCommand('/usr/bin/claude', ['--print', 'hello world'])).toBe(
      `'/usr/bin/claude' '--print' 'hello world'`,
    );
  });
});

describe('guestEngineBinCandidates', () => {
  it('prefers the staged CLI HOME local bin before runner/system paths', () => {
    expect(guestEngineBinCandidates('claude', GUEST_CLI_HOME)[0]).toBe(
      `${GUEST_CLI_HOME}/.local/bin/claude`,
    );
    expect(guestEngineBinCandidates('gemini', GUEST_CLI_HOME)).toContain(
      '/home/runner/.local/bin/gemini',
    );
  });

  it('puts cursor-agent ahead of agent so Grok cannot shadow Cursor', () => {
    const c = guestEngineBinCandidates('agent', GUEST_CLI_HOME);
    expect(c[0]).toBe(`${GUEST_CLI_HOME}/.local/bin/cursor-agent`);
    expect(c).toContain(`${GUEST_CLI_HOME}/.local/bin/agent`);
  });
});

describe('hostCwdToWorktreeRelative', () => {
  it('maps nested cwd under the worktree', () => {
    expect(hostCwdToWorktreeRelative('/wt/server', '/wt')).toBe('server');
    expect(hostCwdToWorktreeRelative('/wt', '/wt')).toBe('.');
  });

  it('rejects escape', () => {
    expect(() => hostCwdToWorktreeRelative('/other', '/wt')).toThrow(/outside/);
  });
});

describe('adaptSpawnEnvForGuest / finalizeGuestSpawnEnv', () => {
  it('remaps HOME outside the worktree and prepends spawn guards on PATH', () => {
    expect(GUEST_CLI_HOME.startsWith(GUEST_RUNTIME_ROOT)).toBe(true);
    expect(GUEST_SKILLS_ROOT.startsWith(GUEST_RUNTIME_ROOT)).toBe(true);
    expect(GUEST_CLI_HOME.includes('/workspace')).toBe(false);

    const adapted = adaptSpawnEnvForGuest(
      {
        HOME: '/host/home',
        ANTHROPIC_API_KEY: 'sk-test',
        AGENT_HUB_SKILLS_DIR: '/host/skills/agent-hub',
        AWS_CONFIG_FILE: '/host/aws/config',
        AGENT_HUB_URL: 'http://10.0.0.1:3051',
        AGENT_HUB_PROTECT_SESSION_BRANCH: '1',
        AGENT_HUB_REAL_GIT: '/host/usr/bin/git',
      },
      {
        guestHome: GUEST_CLI_HOME,
        guestSkillsRoot: GUEST_SKILLS_ROOT,
      },
    );
    expect(adapted.HOME).toBe(GUEST_CLI_HOME);
    expect(adapted.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(adapted.AGENT_HUB_URL).toBe('http://10.0.0.1:3051');
    expect(adapted.AWS_CONFIG_FILE).toBeUndefined();
    expect(adapted.AGENT_HUB_SKILLS_DIR).toBe(`${GUEST_SKILLS_ROOT}/agent-hub`);
    expect(adapted.AGENT_HUB_REAL_GIT).toBe('/usr/bin/git');
    expect(adapted.AGENT_HUB_REAL_GH).toBe('/usr/bin/gh');
    expect(adapted.AGENT_HUB_PROTECT_SESSION_BRANCH).toBe('1');
    expect(adapted.AGENT_CLI_CREDENTIAL_STORE).toBe('file');

    const final = finalizeGuestSpawnEnv(
      adapted,
      [`${GUEST_SKILLS_ROOT}/agent-hub/scripts`],
      GUEST_CLI_HOME,
      { spawnGuardsDir: GUEST_SPAWN_GUARDS_DIR },
    );
    expect(final.PATH!.startsWith(`${GUEST_SPAWN_GUARDS_DIR}:`)).toBe(true);
    expect(final.PATH).toContain(`${GUEST_CLI_HOME}/.local/bin`);
    expect(final.PATH).toContain(`${GUEST_SKILLS_ROOT}/agent-hub/scripts`);
    expect(final.PATH).toContain('/usr/local/bin');
  });
});
