import { describe, expect, it } from 'vitest';
import { orchestrateComposerCopy } from '@shared/utils/orchestrateComposer';
import { composerPlaceholderText } from './composerPlaceholder';

describe('composerPlaceholderText', () => {
  it('shows the Orchestrate placeholder instead of the Consult one', () => {
    const copy = orchestrateComposerCopy('orchestrate');
    expect(
      composerPlaceholderText({ consultMode: true, composerPlaceholder: copy?.placeholder }),
    ).toBe('Plan the work, then start a session…');
  });

  it('falls back to Consult and plain copy', () => {
    expect(composerPlaceholderText({ consultMode: true })).toBe('Consult on Agent Hub…');
    expect(composerPlaceholderText({})).toBe('Message...');
    expect(composerPlaceholderText({ disabled: true, composerPlaceholder: 'x' })).toBe(
      'Waiting...',
    );
  });
});
