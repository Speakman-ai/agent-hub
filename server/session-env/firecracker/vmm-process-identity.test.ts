import { describe, it, expect } from 'vitest';
import {
  classifyProcReadFailure,
  identitiesMatch,
  parseVmmIdentityFile,
} from './vmm-process-identity.js';
import type { VmmProcessIdentity } from './firecracker-session-env.js';

const base: VmmProcessIdentity = {
  pid: 4242,
  cmdline: 'jailer\0--id\0ahvm-1\0',
  starttime: '12345',
  exe: '/usr/bin/jailer',
};

describe('parseVmmIdentityFile', () => {
  it('accepts a well-formed identity', () => {
    expect(parseVmmIdentityFile(JSON.stringify(base))).toEqual(base);
  });

  it('rejects missing fields', () => {
    expect(parseVmmIdentityFile('{"pid":1}')).toBeNull();
    expect(parseVmmIdentityFile('not-json')).toBeNull();
  });
});

describe('classifyProcReadFailure', () => {
  it('reports missing only for ENOENT', () => {
    const err = new Error('gone') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    expect(classifyProcReadFailure(err)).toEqual({ status: 'missing' });
  });

  it('reports unreadable for EACCES rather than treating the VMM as dead', () => {
    const err = new Error('hidden') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    expect(classifyProcReadFailure(err)).toEqual({ status: 'unreadable', reason: 'hidden' });
  });
});

describe('identitiesMatch', () => {
  it('matches pid + starttime + cmdline', () => {
    expect(identitiesMatch(base, { ...base })).toBe(true);
  });

  it('rejects PID reuse with a different starttime', () => {
    expect(identitiesMatch(base, { ...base, starttime: '99999' })).toBe(false);
  });

  it('rejects cmdline drift', () => {
    expect(identitiesMatch(base, { ...base, cmdline: 'firecracker\0' })).toBe(false);
  });

  it('rejects exe mismatch when both sides have exe', () => {
    expect(identitiesMatch(base, { ...base, exe: '/usr/bin/other' })).toBe(false);
  });

  it('allows empty live exe when recorded exe is set', () => {
    expect(identitiesMatch(base, { ...base, exe: '' })).toBe(true);
  });
});
