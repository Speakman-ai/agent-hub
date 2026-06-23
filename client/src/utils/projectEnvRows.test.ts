import { describe, it, expect } from 'vitest';
import {
  envRowsFromDraftAndSecrets,
  isReservedEnvKey,
  RESERVED_ENV_KEY_RE,
} from './projectEnvRows';

describe('isReservedEnvKey', () => {
  it('matches the server reserved namespace (AGENT_HUB_*, NODE_*, PATH, HOME)', () => {
    expect(isReservedEnvKey('AGENT_HUB_API_KEY')).toBe(true);
    expect(isReservedEnvKey('AGENT_HUB_URL')).toBe(true);
    expect(isReservedEnvKey('NODE_ENV')).toBe(true);
    expect(isReservedEnvKey('PATH')).toBe(true);
    expect(isReservedEnvKey('HOME')).toBe(true);
  });

  it('does not over-match non-reserved keys', () => {
    expect(isReservedEnvKey('PATHFINDER')).toBe(false);
    expect(isReservedEnvKey('HOMEPAGE_URL')).toBe(false);
    expect(isReservedEnvKey('MY_API_KEY')).toBe(false);
    expect(isReservedEnvKey(undefined)).toBe(false);
  });

  it('uses the same shape as the server regex', () => {
    expect(RESERVED_ENV_KEY_RE.source).toBe('^(AGENT_HUB_|NODE_|PATH$|HOME$)');
  });
});

describe('envRowsFromDraftAndSecrets', () => {
  it('omits reserved keys so the build payload never trips the 400', () => {
    // Regression: scan suggested AGENT_HUB_API_KEY, the row pre-filled the
    // form, and "Build and run" 400'd on the reserved namespace.
    const draft = {
      envVars: [
        { key: 'AGENT_HUB_API_KEY', sources: ['source'] },
        { key: 'NODE_ENV', sources: ['source'] },
        { key: 'DATABASE_URL', sources: ['env-example'], required: true },
      ],
    };
    const rows = envRowsFromDraftAndSecrets(draft, []);
    const keys = rows.map((r: any) => r.key);
    expect(keys!).toEqual(['DATABASE_URL']);
    expect(keys!).not.toContain('AGENT_HUB_API_KEY');
    expect(keys!).not.toContain('NODE_ENV');
  });

  it('still merges normal suggestions with saved secrets', () => {
    const draft = { envVars: [{ key: 'API_TOKEN', sources: ['source'], required: true }] };
    const secrets = [{ key: 'SAVED_PLAIN', kind: 'plain', value: 'hello' }];
    const rows = envRowsFromDraftAndSecrets(draft, secrets);
    expect(rows.map((r: any) => r.key)).toEqual(['API_TOKEN', 'SAVED_PLAIN']);
    const saved = rows.find((r: any) => r.key === 'SAVED_PLAIN');
    expect(saved!.kind).toBe('plain');
    expect((saved as any).value).toBe('hello');
    expect(saved!.configured).toBe(true);
  });
});
