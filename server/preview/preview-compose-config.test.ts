import { describe, expect, it } from 'vitest';
import {
  isLegacyPreviewComposeConfig,
  LEGACY_COMPOSE_PREVIEW_WARNING,
} from './preview-compose-config.js';

describe('preview compose config modes', () => {
  it('recognizes only the complete legacy app-wrapping pair', () => {
    expect(isLegacyPreviewComposeConfig({ entryService: 'web', entryPort: 3000 })).toBe(true);
    expect(isLegacyPreviewComposeConfig({ entryService: 'web' })).toBe(false);
    expect(isLegacyPreviewComposeConfig({ entryPort: 3000 })).toBe(false);
    expect(isLegacyPreviewComposeConfig({ entryService: 'web', entryPort: 0 })).toBe(false);
    expect(isLegacyPreviewComposeConfig({ file: 'compose.yml' })).toBe(false);
  });

  it('keeps the fallback warning actionable', () => {
    expect(LEGACY_COMPOSE_PREVIEW_WARNING).toContain('devServer');
    expect(LEGACY_COMPOSE_PREVIEW_WARNING).toContain('backing services');
  });
});
