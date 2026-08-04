import { describe, it, expect } from 'vitest';
import {
  buildSecurityAutofixPatch,
  isSecurityAutofixMode,
  nextAutofixConfig,
  readSecurityAutofixConfig,
  securityAutofixMode,
  SECURITY_AUTOFIX_OPTIONS,
} from './securityAutofix';

describe('readSecurityAutofixConfig', () => {
  it('defaults both flags to false when the project never opted in', () => {
    expect(readSecurityAutofixConfig({})).toEqual({ enabled: false, autoMerge: false });
    expect(readSecurityAutofixConfig(null)).toEqual({ enabled: false, autoMerge: false });
    expect(readSecurityAutofixConfig(undefined)).toEqual({ enabled: false, autoMerge: false });
  });

  it('coerces non-boolean persisted values rather than trusting them', () => {
    expect(readSecurityAutofixConfig({ securityAutoPr: { enabled: 'yes', autoMerge: 1 } })).toEqual(
      { enabled: false, autoMerge: false },
    );
  });

  it('reads the persisted block', () => {
    expect(
      readSecurityAutofixConfig({ securityAutoPr: { enabled: true, autoMerge: true } }),
    ).toEqual({ enabled: true, autoMerge: true });
  });
});

describe('securityAutofixMode', () => {
  it('maps the two booleans onto the three UI choices', () => {
    expect(securityAutofixMode({ enabled: false, autoMerge: false })).toBe('off');
    expect(securityAutofixMode({ enabled: true, autoMerge: false })).toBe('pr');
    expect(securityAutofixMode({ enabled: true, autoMerge: true })).toBe('merge');
  });

  it('treats autoMerge without enabled as off — nothing dispatches to merge', () => {
    expect(securityAutofixMode({ enabled: false, autoMerge: true })).toBe('off');
  });
});

describe('buildSecurityAutofixPatch', () => {
  it('always sends both keys so a downgrade actually clears autoMerge', () => {
    expect(buildSecurityAutofixPatch('off')).toEqual({ enabled: false, autoMerge: false });
    expect(buildSecurityAutofixPatch('pr')).toEqual({ enabled: true, autoMerge: false });
    expect(buildSecurityAutofixPatch('merge')).toEqual({ enabled: true, autoMerge: true });
  });

  it('never sends actorUserId — the server defaults it to the requesting Admin', () => {
    expect(Object.keys(buildSecurityAutofixPatch('merge'))).toEqual(['enabled', 'autoMerge']);
  });
});

describe('nextAutofixConfig', () => {
  const off = { enabled: false, autoMerge: false };

  it('returns null for a no-op change', () => {
    expect(nextAutofixConfig(off, 'off')).toBeNull();
    expect(nextAutofixConfig({ enabled: true, autoMerge: true }, 'merge')).toBeNull();
  });

  it('returns null for an unrecognised value', () => {
    expect(nextAutofixConfig(off, 'sometimes')).toBeNull();
  });

  it('produces the config for a real change', () => {
    expect(nextAutofixConfig(off, 'merge')).toEqual({ enabled: true, autoMerge: true });
    expect(nextAutofixConfig({ enabled: true, autoMerge: true }, 'pr')).toEqual({
      enabled: true,
      autoMerge: false,
    });
  });
});

describe('SECURITY_AUTOFIX_OPTIONS', () => {
  it('offers exactly the three valid modes, opt-out first', () => {
    expect(SECURITY_AUTOFIX_OPTIONS.map((o) => o.value)).toEqual(['off', 'pr', 'merge']);
    expect(SECURITY_AUTOFIX_OPTIONS.every((o) => isSecurityAutofixMode(o.value))).toBe(true);
  });
});
