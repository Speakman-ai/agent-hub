import { describe, it, expect } from 'vitest';
import { formatSystemBannerModelLine, modelPrimaryLabel } from '@shared/utils/systemBannerModel';

describe('modelPrimaryLabel', () => {
  it('maps known ids', () => {
    expect(modelPrimaryLabel('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(modelPrimaryLabel('claude-sonnet-5')).toBe('Sonnet');
    // Retired-from-selection id keeps a clean historical label.
    expect(modelPrimaryLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  it('title-cases unknown ids', () => {
    expect(modelPrimaryLabel('custom-model-id')).toBe('Custom Model Id');
  });

  it('returns empty for blank', () => {
    expect(modelPrimaryLabel('')).toBe('');
    expect(modelPrimaryLabel(null)).toBe('');
    expect(modelPrimaryLabel('   ')).toBe('');
  });
});

describe('formatSystemBannerModelLine', () => {
  it('prefers stream model over session', () => {
    expect(
      formatSystemBannerModelLine({
        streamModel: 'gpt-5.4',
        sessionModel: 'gpt-5.2',
        sessionEngine: 'codex-cli',
      }),
    ).toBe('GPT-5.4');
  });

  it('uses session model when stream omits model (Codex thread.started)', () => {
    expect(
      formatSystemBannerModelLine({
        streamModel: null,
        sessionModel: 'gpt-5.3-codex',
        sessionEngine: 'codex-cli',
      }),
    ).toBe('GPT-5.3 Codex');
  });

  it('shows engine session default when no model ids are present', () => {
    expect(
      formatSystemBannerModelLine({
        streamModel: null,
        sessionModel: null,
        sessionEngine: 'codex-cli',
      }),
    ).toBe('Codex · session default');
  });

  it('never uses the word unknown', () => {
    const line = formatSystemBannerModelLine({
      streamModel: null,
      sessionModel: null,
      sessionEngine: null,
    });
    expect(line.toLowerCase()).not.toContain('unknown');
  });
});
