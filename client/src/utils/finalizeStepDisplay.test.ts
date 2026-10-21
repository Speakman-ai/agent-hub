import { describe, expect, it } from 'vitest';
import { MinusCircle, Clock } from 'lucide-react';
import { labelForStepState, stepIconFor, stepToneFor } from './finalizeStepDisplay';

describe('finalizeStepDisplay not_selected', () => {
  it('renders a step left out by test selection as its own greyed state', () => {
    expect(labelForStepState('not_selected')).toBe('not selected');
    expect(stepIconFor('not_selected')).toBe(MinusCircle);
    expect(stepIconFor('not_selected')).not.toBe(Clock);
    expect(stepToneFor('not_selected')).toContain('text-slate-500');
  });
});
