import { describe, it, expect } from 'vitest';
import {
  resolveTemplateId,
  stackWasExplicit,
  KNOWN_TEMPLATE_IDS,
  UNIVERSAL_DEFAULT_TEMPLATE_ID,
  APP_TYPE_DEFAULTS,
} from './stack-defaults.js';

describe('resolveTemplateId — explicit stack wins', () => {
  it('returns a known language template id verbatim', () => {
    expect(resolveTemplateId('api', 'python-fastapi-uv')).toBe('python-fastapi-uv');
    expect(resolveTemplateId(null, 'go-cobra')).toBe('go-cobra');
    expect(resolveTemplateId('web-app', 'typescript-node-tsx')).toBe('typescript-node-tsx');
    expect(resolveTemplateId('api', 'rust-axum')).toBe('rust-axum');
  });
});

describe('resolveTemplateId — description-first defaults to blank', () => {
  it('ignores appType when stack is missing or idk', () => {
    expect(resolveTemplateId('web-app', null)).toBe('blank');
    expect(resolveTemplateId('api', null)).toBe('blank');
    expect(resolveTemplateId('cli', 'idk')).toBe('blank');
    expect(resolveTemplateId('ml', 'idk')).toBe('blank');
  });

  it('treats an unrecognized stack string as blank, not an appType default', () => {
    expect(resolveTemplateId('api', 'fastapi-postgres')).toBe('blank');
    expect(resolveTemplateId('cli', 'python-click')).toBe('blank');
  });
});

describe('resolveTemplateId — universal fallback', () => {
  it('returns blank when neither appType nor stack is a known template id', () => {
    expect(resolveTemplateId(null, null)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId(undefined, undefined)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId('idk', 'idk')).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(resolveTemplateId('something-new', null)).toBe(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(UNIVERSAL_DEFAULT_TEMPLATE_ID).toBe('blank');
  });

  it('returns a template id that exists in the known set', () => {
    expect(KNOWN_TEMPLATE_IDS).toContain(UNIVERSAL_DEFAULT_TEMPLATE_ID);
    expect(KNOWN_TEMPLATE_IDS).toContain('blank');
    for (const [appType, id] of Object.entries(APP_TYPE_DEFAULTS)) {
      expect(KNOWN_TEMPLATE_IDS, `APP_TYPE_DEFAULTS.${appType} → ${id}`).toContain(id);
    }
  });
});

describe('stackWasExplicit', () => {
  it('is true only when the caller passed a known language template id', () => {
    expect(stackWasExplicit('typescript-node-tsx')).toBe(true);
    expect(stackWasExplicit('go-cobra')).toBe(true);
    expect(stackWasExplicit('blank')).toBe(false);
    expect(stackWasExplicit('idk')).toBe(false);
    expect(stackWasExplicit(null)).toBe(false);
    expect(stackWasExplicit(undefined)).toBe(false);
    expect(stackWasExplicit('fastapi-postgres')).toBe(false);
  });
});
