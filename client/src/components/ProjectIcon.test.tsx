import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProjectIcon from './ProjectIcon';

describe('ProjectIcon', () => {
  it('always renders the folder icon', () => {
    const { rerender } = render(<ProjectIcon project={{ icon: 'Rocket', color: '#ff0000' }} />);
    expect(screen.getByTestId('project-icon')).toHaveAttribute('data-icon', 'Folder');
    rerender(<ProjectIcon project={{ icon: null, color: '#ff0000' }} />);
    expect(screen.getByTestId('project-icon')).toHaveAttribute('data-icon', 'Folder');
  });
});
