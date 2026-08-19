import { describe, expect, it } from 'vitest';
import { RELEASE_DIGEST_MODEL_ONLY_SYSTEM_PROMPT } from './release-digest-model.js';
import { RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES } from './release-digest-prompt.js';

describe('release digest grouping and coverage rules', () => {
  it('keeps grouping and coverage in one shared block used by the model prompt', () => {
    expect(RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES).toContain(
      'Follow operator guidance for grouping, tone, audience, and emphasis.',
    );
    expect(RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES).toContain('not a required outline');
    expect(RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES).toContain(
      'Account for every included release item',
    );
    expect(RELEASE_DIGEST_MODEL_ONLY_SYSTEM_PROMPT).toContain(
      RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES,
    );
  });
});
