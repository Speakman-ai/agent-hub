import { describe, it, expect } from 'vitest';

import { formatSystemBannerModelLine, modelPrimaryLabel } from './systemBannerModel.js';

describe('systemBannerModel', () => {
  it('maps gpt-5.5 to GPT-5.5', () => {
    expect(modelPrimaryLabel('gpt-5.5')).toBe('GPT-5.5');
  });

  it('maps gpt-5.6 to GPT-5.6', () => {
    expect(modelPrimaryLabel('gpt-5.6')).toBe('GPT-5.6');
  });

  it('maps claude-opus-4-8 to Opus 4.8', () => {
    expect(modelPrimaryLabel('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('maps claude-fable-5 to Fable 5', () => {
    expect(modelPrimaryLabel('claude-fable-5')).toBe('Fable 5');
  });

  it('maps claude-sonnet-5 to Sonnet and keeps claude-sonnet-4-6 as historical', () => {
    expect(modelPrimaryLabel('claude-sonnet-5')).toBe('Sonnet');
    expect(modelPrimaryLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
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
