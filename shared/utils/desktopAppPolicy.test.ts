import { describe, expect, it } from 'vitest';
import {
  desktopAppDomain,
  desktopAppFromDomain,
  formatPolicyDomain,
  normalizeDesktopAppName,
  parseDesktopAppInput,
} from './desktopAppPolicy';
import { normalizePolicyDomainInput } from './browserProfiles';

describe('desktop app policy domains', () => {
  it('normalizes WM_CLASS names into app keys', () => {
    expect(normalizeDesktopAppName('Google-chrome')).toBe('google-chrome');
    expect(normalizeDesktopAppName(' Libre Office ')).toBe('libre-office');
    expect(normalizeDesktopAppName('***')).toBeNull();
    expect(desktopAppDomain('XTerm')).toBe('xterm.desktop.invalid');
  });

  it('maps pseudo-domains back to apps and leaves real sites alone', () => {
    expect(desktopAppFromDomain('chromium.desktop.invalid')).toBe('chromium');
    expect(desktopAppFromDomain('desktop.invalid')).toBe('');
    expect(desktopAppFromDomain('shop.com')).toBeNull();
  });

  it('parses desktop:<app> input, including in the site policy form', () => {
    expect(parseDesktopAppInput('desktop:Chromium')).toBe('chromium.desktop.invalid');
    expect(parseDesktopAppInput('desktop')).toBe('desktop.invalid');
    expect(parseDesktopAppInput('desktop:')).toBeNull();
    expect(normalizePolicyDomainInput('desktop:shell')).toBe('shell.desktop.invalid');
    expect(normalizePolicyDomainInput('https://Shop.com/cart')).toBe('shop.com');
  });

  it('labels policy domains for people', () => {
    expect(formatPolicyDomain('chromium.desktop.invalid')).toBe('chromium (desktop app)');
    expect(formatPolicyDomain('shell.desktop.invalid')).toBe('desktop shell commands');
    expect(formatPolicyDomain('desktop.invalid')).toBe('all desktop apps');
    expect(formatPolicyDomain('shop.com')).toBe('shop.com');
  });
});
