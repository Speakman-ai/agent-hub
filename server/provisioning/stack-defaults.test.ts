import { describe, it, expect } from 'vitest';
import {
  resolveTemplateId,
  stackWasExplicit,
  KNOWN_TEMPLATE_IDS,
  UNIVERSAL_DEFAULT_TEMPLATE_ID,
  APP_TYPE_DEFAULTS,
} from './stack-defaults.js';

describe('resolveTemplateId — explicit stack wins', () => {
  it('returns the stack verbatim when it matches a known template id', () => {
    for (const id of KNOWN_TEMPLATE_IDS) {
      // Pair with a mismatching appType to prove stack beats appType.
      expect(resolveTemplateId('api', id)).toBe(id);
      expect(resolveTemplateId(null, id)).toBe(id);
    }
  });
});

describe('resolveTemplateId — appType defaulting when stack is missing', () => {
  it('maps each known appType to its configured default', () => {
    expect(resolveTemplateId('web-app', null)).toBe('typescript-node-tsx');
    expect(resolveTemplateId('api', null)).toBe('python-fastapi-uv');
    expect(resolveTemplateId('cli', null)).toBe('go-cobra');
    expect(resolveTemplateId('ml', null)).toBe('python-fastapi-uv');
    expect(resolveTemplateId('library', null)).toBe('typescript-node-tsx');
  });

  it('treats stack:"idk" the same as missing', () => {
    expect(resolveTemplateId('cli', 'idk')).toBe('go-cobra');
    expect(resolveTemplateId('api', 'idk')).toBe('python-fastapi-uv');
  });

  it('treats an unrecognized stack string the same as missing', () => {
    // The questionnaire ships e.g. 'fastapi-postgres' which isn't one of our
    // template ids; fall through to the appType default rather than erroring.
    expect(resolveTemplateId('api', 'fastapi-postgres')).toBe('python-fastapi-uv');
    expect(resolveTemplateId('cli', 'python-click')).toBe('go-cobra');
  });

  it('accepts storyboard aliases (Bot → python)', () => {
    expect(resolveTemplateId('bot', 'idk')).toBe('python-fastapi-uv');
  });
});

describe('resolveTemplateId — universal fallback', () => {
  it('returns typescript when neither appType nor stack is recognised', () => {
    expect(resolveTemplateId(null, null)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId(undefined, undefined)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId('idk', 'idk')).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId('something-new', null)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
  });

  it('returns a template id that exists in the known set', () => {
    // Exhaustive sanity check — every APP_TYPE_DEFAULTS entry and the
    // universal default must resolve to a real template id.
    expect(KNOWN_TEMPLATE_IDS).toContain(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    for (const [appType, id] of Object.entries(APP_TYPE_DEFAULTS)) {
      expect(KNOWN_TEMPLATE_IDS, `APP_TYPE_DEFAULTS.${appType} → ${id}`).toContain(id);
    }
  });
});

describe('stackWasExplicit', () => {
  it('is true only when the caller passed a known template id', () => {
    expect(stackWasExplicit('typescript-node-tsx')).toBe(true);
    expect(stackWasExplicit('go-cobra')).toBe(true);
    expect(stackWasExplicit('idk')).toBe(false);
    expect(stackWasExplicit(null)).toBe(false);
    expect(stackWasExplicit(undefined)).toBe(false);
    expect(stackWasExplicit('fastapi-postgres')).toBe(false);
  });
});
