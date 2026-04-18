import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('hunter2-is-a-bad-password');
    expect(await verifyPassword('hunter2', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same-input');
    const b = await hashPassword('same-input');
    expect(a).not.toBe(b);
    // But both verify against the original input.
    expect(await verifyPassword('same-input', a)).toBe(true);
    expect(await verifyPassword('same-input', b)).toBe(true);
  });

  it('rejects empty passwords at hash time', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('returns false on malformed stored strings', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$only$partial')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$abc$def$ghi$jkl$mno')).toBe(false); // non-numeric params
  });
});
