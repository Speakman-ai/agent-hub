import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectIconEditor from './ProjectIconEditor';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({ api: { updateProject: vi.fn() } }));
const project = { id: 'p1', icon: '★', color: '#ff0000' };

beforeEach(() => {
  vi.mocked(api.updateProject)
    .mockReset()
    .mockResolvedValue({ ...project, name: 'Project', cwd: '/tmp' });
});
describe('ProjectIconEditor', () => {
  it('previews and saves emoji, refreshes the project, and restores color', async () => {
    const refresh = vi.fn();
    render(<ProjectIconEditor project={project} onProjectsChange={refresh} />);
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: '👩🏽‍💻' } });
    expect(screen.getByTestId('project-icon')).toHaveTextContent('👩🏽‍💻');
    fireEvent.click(screen.getByRole('button', { name: 'Save icon' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(api.updateProject).toHaveBeenLastCalledWith('p1', { icon: '👩🏽‍💻' });
    fireEvent.click(screen.getByRole('button', { name: 'Use color' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(api.updateProject).toHaveBeenLastCalledWith('p1', { icon: null });
    expect(screen.getByTestId('project-icon')).toHaveStyle({ backgroundColor: '#ff0000' });
  });

  it('shows a save error and retains the draft for retry', async () => {
    vi.mocked(api.updateProject).mockRejectedValue(new Error('Could not save'));
    const refresh = vi.fn();
    render(<ProjectIconEditor project={project} onProjectsChange={refresh} />);
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: '🚀' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save icon' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.getByLabelText('Project icon')).toHaveValue('🚀');
    expect(refresh).not.toHaveBeenCalled();
  });
});
