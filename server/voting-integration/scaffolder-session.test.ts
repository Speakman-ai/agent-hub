import { describe, it, expect } from 'vitest';
import {
  buildVotingScaffolderSessionName,
  isVotingScaffolderSession,
  resolveVotingScaffolderFirstTurnPrompt,
  VOTING_SCAFFOLDER_SESSION_PREFIX,
} from './scaffolder-session.js';

describe('isVotingScaffolderSession', () => {
  it('matches sessions named with the voting-setup prefix', () => {
    expect(isVotingScaffolderSession({ name: '[Voting Setup] acme-app' })).toBe(true);
    expect(isVotingScaffolderSession({ name: `${VOTING_SCAFFOLDER_SESSION_PREFIX} x` })).toBe(true);
  });

  it('does not match other sessions', () => {
    expect(isVotingScaffolderSession({ name: '[Preview Setup] acme-app' })).toBe(false);
    expect(isVotingScaffolderSession({ name: 'Fix voting bug' })).toBe(false);
    expect(isVotingScaffolderSession({ name: null })).toBe(false);
    expect(isVotingScaffolderSession(null)).toBe(false);
    expect(isVotingScaffolderSession(undefined)).toBe(false);
  });
});

describe('buildVotingScaffolderSessionName', () => {
  it('prefixes the target project id', () => {
    expect(buildVotingScaffolderSessionName('acme-app')).toBe('[Voting Setup] acme-app');
  });
});

describe('resolveVotingScaffolderFirstTurnPrompt', () => {
  it('returns a prefixed name and the rendered pack as the prompt', () => {
    const resolved = resolveVotingScaffolderFirstTurnPrompt({
      targetProjectId: 'acme-app',
      pageNameHint: 'Ideas',
    });
    expect(resolved.name).toBe('[Voting Setup] acme-app');
    expect(isVotingScaffolderSession({ name: resolved.name })).toBe(true);
    expect(resolved.prompt).toContain('Voting integration task pack');
    expect(resolved.prompt).toContain('project `acme-app`');
    expect(resolved.prompt).toContain('Ideas');
  });

  it('propagates target-project validation from the renderer', () => {
    expect(() =>
      resolveVotingScaffolderFirstTurnPrompt({ targetProjectId: 'bad slug/../x' }),
    ).toThrow(/project slug/);
  });
});
