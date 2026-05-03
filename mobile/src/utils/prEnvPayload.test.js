import { describe, it, expect } from 'vitest';
import {
  MASK,
  DISPLAY_MASK,
  CHECK_LABELS,
  CHECK_ORDER,
  buildEnabledTogglePayload,
  maskedDisplay,
  formatPortRange,
  formatValidateRows,
} from './prEnvPayload.js';

describe('buildEnabledTogglePayload', () => {
  it('returns only the enabled key (true)', () => {
    expect(buildEnabledTogglePayload(true)).toEqual({ enabled: true });
  });
  it('returns only the enabled key (false)', () => {
    expect(buildEnabledTogglePayload(false)).toEqual({ enabled: false });
  });
  it('coerces truthy/falsy inputs to a boolean', () => {
    expect(buildEnabledTogglePayload(1)).toEqual({ enabled: true });
    expect(buildEnabledTogglePayload(0)).toEqual({ enabled: false });
    expect(buildEnabledTogglePayload(undefined)).toEqual({ enabled: false });
    expect(buildEnabledTogglePayload(null)).toEqual({ enabled: false });
  });
  it('does NOT include credential or Tier 1 fields — MVP is enabled-only', () => {
    const payload = buildEnabledTogglePayload(true);
    expect(payload).not.toHaveProperty('repoFullName');
    expect(payload).not.toHaveProperty('githubPrivateKey');
    expect(payload).not.toHaveProperty('portRangeMin');
    expect(payload).not.toHaveProperty('portRangeMax');
  });
});

describe('maskedDisplay', () => {
  it('renders unset values as em-dash', () => {
    expect(maskedDisplay(null)).toBe('—');
    expect(maskedDisplay(undefined)).toBe('—');
    expect(maskedDisplay('')).toBe('—');
  });
  it('renders the server MASK sentinel as a shorter display mask', () => {
    expect(maskedDisplay(MASK)).toBe(DISPLAY_MASK);
  });
  it('passes through plain strings', () => {
    expect(maskedDisplay('acme/widgets')).toBe('acme/widgets');
    expect(maskedDisplay('https://pr.preview.example.com')).toBe('https://pr.preview.example.com');
  });
  it('stringifies numbers', () => {
    expect(maskedDisplay(42)).toBe('42');
  });
});

describe('formatPortRange', () => {
  it('returns em-dash when either bound is missing', () => {
    expect(formatPortRange(null, null)).toBe('—');
    expect(formatPortRange(8000, null)).toBe('—');
    expect(formatPortRange(null, 8999)).toBe('—');
    expect(formatPortRange('', '')).toBe('—');
    expect(formatPortRange(undefined, undefined)).toBe('—');
  });
  it('formats numeric bounds with an en-dash', () => {
    expect(formatPortRange(8000, 8999)).toBe('8000–8999');
  });
  it('coerces numeric strings', () => {
    expect(formatPortRange('8000', '8999')).toBe('8000–8999');
  });
  it('returns em-dash on non-finite input', () => {
    expect(formatPortRange('abc', 8999)).toBe('—');
  });
});

describe('formatValidateRows', () => {
  const PASS = (name, message = 'ok') => ({ name, pass: true, message });
  const FAIL = (name, message = 'bad') => ({ name, pass: false, message });

  it('returns [] for falsy or malformed input', () => {
    expect(formatValidateRows(null)).toEqual([]);
    expect(formatValidateRows(undefined)).toEqual([]);
    expect(formatValidateRows({})).toEqual([]);
    expect(formatValidateRows({ checks: 'nope' })).toEqual([]);
  });

  it('renders the 4 canonical rows in stable order even when input is shuffled', () => {
    const result = {
      ok: false,
      checks: [
        FAIL('route53', 'hosted zone unreachable'),
        PASS('docker', 'Docker daemon reachable.'),
        FAIL('github-app', 'no installation token'),
        PASS('nginx', 'Writable: a, b'),
      ],
    };
    const rows = formatValidateRows(result);
    expect(rows.map((r) => r.name)).toEqual(CHECK_ORDER);
    expect(rows[0]).toMatchObject({ name: 'docker', label: CHECK_LABELS.docker, pass: true });
    expect(rows[1]).toMatchObject({ name: 'nginx', pass: true });
    expect(rows[2]).toMatchObject({ name: 'github-app', pass: false, message: 'no installation token' });
    expect(rows[3]).toMatchObject({ name: 'route53', pass: false });
  });

  it('renders a missing canonical check as failed with a placeholder message', () => {
    const result = { ok: false, checks: [PASS('docker'), PASS('nginx'), PASS('github-app')] };
    const rows = formatValidateRows(result);
    const route = rows.find((r) => r.name === 'route53');
    expect(route).toBeDefined();
    expect(route.pass).toBe(false);
    expect(route.missing).toBe(true);
    expect(route.message).toMatch(/no result/i);
  });

  it('appends unknown server-side check names after the canonical 4', () => {
    const result = {
      ok: false,
      checks: [
        PASS('docker'),
        PASS('nginx'),
        PASS('github-app'),
        PASS('route53'),
        FAIL('future-check', 'tbd'),
      ],
    };
    const rows = formatValidateRows(result);
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ name: 'future-check', pass: false, message: 'tbd' });
  });

  it('handles a mixed pass/fail result for the smoke-test renderer scenario', () => {
    const result = {
      ok: false,
      checks: [
        PASS('docker', 'Docker daemon reachable.'),
        FAIL('nginx', '/etc/nginx/sites-enabled: EACCES'),
        PASS('github-app', 'Installation token obtained.'),
        FAIL('route53', 'GetHostedZone failed (exit 254)'),
      ],
    };
    const rows = formatValidateRows(result);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.pass)).toHaveLength(2);
    expect(rows.filter((r) => !r.pass).map((r) => r.name)).toEqual(['nginx', 'route53']);
    // Labels surface to the UI verbatim.
    expect(rows.map((r) => r.label)).toEqual([
      'Docker daemon',
      'Nginx sites dirs',
      'GitHub App',
      'Route53 hosted zone',
    ]);
  });
});
