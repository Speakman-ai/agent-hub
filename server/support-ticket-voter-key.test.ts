import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';

import { deriveVoterKeyFromEmail } from './support-ticket-voter-key.js';

describe('deriveVoterKeyFromEmail', () => {
  it('hashes salt + lowercased trimmed email and never returns the address', () => {
    const key = deriveVoterKeyFromEmail('  Ada@Example.COM ', 'server-salt');
    expect(key).toBe(
      createHash('sha256')
        .update('server-salt', 'utf8')
        .update('ada@example.com', 'utf8')
        .digest('hex'),
    );
    expect(key).toHaveLength(64);
    expect(key).not.toMatch(/ada|example|@/i);
  });

  it('is stable across casing and rejects empty email or salt', () => {
    expect(deriveVoterKeyFromEmail('a@b.co', 's')).toBe(deriveVoterKeyFromEmail('A@B.CO', 's'));
    expect(() => deriveVoterKeyFromEmail('  ', 's')).toThrow(/email is required/);
    expect(() => deriveVoterKeyFromEmail('a@b.co', '')).toThrow(/vote salt is required/);
  });
});
