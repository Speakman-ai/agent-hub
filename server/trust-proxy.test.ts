import { describe, it, expect } from 'vitest';
import { trustProxyValueFromEnv } from './trust-proxy.js';

describe('trustProxyValueFromEnv', () => {
  it('defaults to loopback when unset or 0', () => {
    expect(trustProxyValueFromEnv({})).toBe('loopback');
    expect(trustProxyValueFromEnv({ TRUST_PROXY: '0' })).toBe('loopback');
    expect(trustProxyValueFromEnv({ TRUST_PROXY: '   ' })).toBe('loopback');
  });
  it('treats 1, true, yes as one hop', () => {
    expect(trustProxyValueFromEnv({ TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxyValueFromEnv({ TRUST_PROXY: 'true' })).toBe(1);
    expect(trustProxyValueFromEnv({ TRUST_PROXY: 'yes' })).toBe(1);
  });
  it('parses numeric hop count with bounds', () => {
    expect(trustProxyValueFromEnv({ TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxyValueFromEnv({ TRUST_PROXY: '100' })).toBe(32);
  });
  it('rejects non-numeric junk', () => {
    expect(trustProxyValueFromEnv({ TRUST_PROXY: 'alb' })).toBe('loopback');
  });
});
