import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProjectIcon from './ProjectIcon';

describe('ProjectIcon', () => {
  it('shows complete emoji sequences and restores the colored marker when cleared', () => {
    const { rerender } = render(<ProjectIcon project={{ icon: '👩🏽‍💻', color: '#ff0000' }} />);
    expect(screen.getByTestId('project-icon')).toHaveTextContent('👩🏽‍💻');
    expect(screen.getByTestId('project-icon').style.backgroundColor).toBe('transparent');
    rerender(<ProjectIcon project={{ icon: null, color: '#ff0000' }} />);
    expect(screen.getByTestId('project-icon')).toBeEmptyDOMElement();
    expect(screen.getByTestId('project-icon')).toHaveStyle({ backgroundColor: '#ff0000' });
  });
});
