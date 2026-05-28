import { describe, it, expect } from 'vitest';

import { formatSystemBannerModelLine, modelPrimaryLabel } from './systemBannerModel.js';

describe('systemBannerModel', () => {
  it('maps claude-opus-4-8 to Opus 4.8', () => {
    expect(modelPrimaryLabel('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('prefers stream model and renders Opus 4.8 in banner', () => {
    expect(
      formatSystemBannerModelLine({
        streamModel: 'claude-opus-4-8',
        sessionModel: 'claude-sonnet-4-6',
        sessionEngine: 'claude-code',
      }),
    ).toBe('Opus 4.8');
  });
});
