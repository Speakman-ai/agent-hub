import { describe, it, expect } from 'vitest';
import {
  adaptSpawnEnvForGuest,
  buildGuestCliCommand,
  finalizeGuestSpawnEnv,
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
  it('remaps HOME and drops host-only paths', () => {
    const adapted = adaptSpawnEnvForGuest(
      {
        HOME: '/host/home',
        ANTHROPIC_API_KEY: 'sk-test',
        AGENT_HUB_SKILLS_DIR: '/host/skills/agent-hub',
        AWS_CONFIG_FILE: '/host/aws/config',
        AGENT_HUB_URL: 'http://10.0.0.1:3051',
      },
      {
        guestHome: '/workspace/.agent-hub/cli-home',
        guestSkillsRoot: '/workspace/.agent-hub/bundled-skills',
      },
    );
    expect(adapted.HOME).toBe('/workspace/.agent-hub/cli-home');
    expect(adapted.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(adapted.AGENT_HUB_URL).toBe('http://10.0.0.1:3051');
    expect(adapted.AWS_CONFIG_FILE).toBeUndefined();
    expect(adapted.AGENT_HUB_SKILLS_DIR).toBe('/workspace/.agent-hub/bundled-skills/agent-hub');

    const final = finalizeGuestSpawnEnv(
      adapted,
      ['/workspace/.agent-hub/bundled-skills/agent-hub/scripts'],
      '/workspace/.agent-hub/cli-home',
    );
    expect(final.PATH).toContain('/workspace/.agent-hub/cli-home/.local/bin');
    expect(final.PATH).toContain('/workspace/.agent-hub/bundled-skills/agent-hub/scripts');
    expect(final.PATH).toContain('/usr/local/bin');
  });
});
