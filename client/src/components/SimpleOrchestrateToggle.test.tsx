import { fireEvent, render, screen } from '@testing-library/react';
import SimpleOrchestrateToggle from './SimpleOrchestrateToggle';

describe('SimpleOrchestrateToggle', () => {
  it('reports the opposite of the current state', () => {
    const onChange = vi.fn();
    const view = render(<SimpleOrchestrateToggle enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('simple-orchestrate-toggle'));
    expect(onChange).toHaveBeenCalledWith(true);

    view.rerender(<SimpleOrchestrateToggle enabled onChange={onChange} />);
    expect(screen.getByRole('switch', { name: 'Orchestrate' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByTestId('simple-orchestrate-toggle'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
