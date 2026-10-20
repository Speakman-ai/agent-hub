import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Checkbox from './Checkbox';

describe('Checkbox', () => {
  it('toggles through a real checkbox and shows the mark when checked', () => {
    const onChange = vi.fn();
    render(
      <label>
        <Checkbox aria-label="Link project" checked={false} onChange={onChange} />
        Link project
      </label>,
    );
    const input = screen.getByRole('checkbox', { name: 'Link project' });
    expect(input).not.toBeChecked();
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalled();
    expect(input.parentElement?.querySelector('span')).toHaveClass('peer-checked:bg-emerald-500');
  });
});
