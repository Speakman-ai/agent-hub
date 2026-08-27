import { describe, it, expect } from 'vitest';
import { resolveBranchLsRemoteTarget } from './projects.js';
import { redactToken } from '../clone-url-auth.js';

describe('resolveBranchLsRemoteTarget', () => {
  const token = 'ghp_secret_value_1234';

  it('embeds the token in a github-https origin so git never prompts', () => {
    const { target, injectedToken } = resolveBranchLsRemoteTarget(
      'https://github.com/AI-Metrics-Inc/eRadiometrics-viewer.git',
      token,
    );
    expect(target).toBe(
      `https://x-access-token:${token}@github.com/AI-Metrics-Inc/eRadiometrics-viewer.git`,
    );
    expect(injectedToken).toBe(token);
  });

  it('handles a github-https origin without the .git suffix', () => {
    const { target } = resolveBranchLsRemoteTarget('https://github.com/foo/bar', token);
    expect(target).toBe(`https://x-access-token:${token}@github.com/foo/bar.git`);
  });

  it('falls through to plain origin when no token resolves', () => {
    for (const t of [null, undefined, '']) {
      const { target, injectedToken } = resolveBranchLsRemoteTarget(
        'https://github.com/foo/bar.git',
        t,
      );
      expect(target).toBe('origin');
      expect(injectedToken).toBeNull();
    }
  });

  it('never injects into an SSH remote (leaves origin untouched)', () => {
    const { target, injectedToken } = resolveBranchLsRemoteTarget(
      'git@github.com:foo/bar.git',
      token,
    );
    expect(target).toBe('origin');
    expect(injectedToken).toBeNull();
  });

  it('never injects into a non-github (Hub-hosted) remote', () => {
    const { target, injectedToken } = resolveBranchLsRemoteTarget(
      'https://hub.example.com/git/agent-hub.git',
      token,
    );
    expect(target).toBe('origin');
    expect(injectedToken).toBeNull();
  });

  it('redacts the injected token from an ls-remote error message', () => {
    const { injectedToken } = resolveBranchLsRemoteTarget('https://github.com/foo/bar.git', token);
    // Simulate git echoing the tokenized URL back in a failure.
    const gitErr = `fatal: could not read from 'https://x-access-token:${token}@github.com/foo/bar.git'`;
    const redacted = redactToken(gitErr, injectedToken);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('***');
  });
});
