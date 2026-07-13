import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjectMembers: vi.fn(),
    getOrgUsers: vi.fn(),
    addProjectMember: vi.fn(),
    removeProjectMember: vi.fn(),
  },
}));

import ProjectMembersSection from './ProjectMembersSection';
import { api } from '../utils/api';

const getProjectMembers = api.getProjectMembers as unknown as ReturnType<typeof vi.fn>;
const getOrgUsers = api.getOrgUsers as unknown as ReturnType<typeof vi.fn>;
const addProjectMember = api.addProjectMember as unknown as ReturnType<typeof vi.fn>;
const removeProjectMember = api.removeProjectMember as unknown as ReturnType<typeof vi.fn>;

const project = { id: 'proj-1', name: 'Proj 1' };

beforeEach(() => {
  vi.clearAllMocks();
  getOrgUsers.mockResolvedValue({
    users: [
      { id: 'creator', username: 'creator', role: 'Owner' },
      { id: 'bob', username: 'bob', role: 'User' },
    ],
  });
});

afterEach(() => vi.restoreAllMocks());

describe('ProjectMembersSection', () => {
  it('hides itself when the members endpoint returns 403 (non-Owner)', async () => {
    getProjectMembers.mockRejectedValue(new Error('Owner role required'));
    const { container } = render(<ProjectMembersSection project={project} />);
    await waitFor(() => expect(getProjectMembers).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(getOrgUsers).not.toHaveBeenCalled();
  });

  it('shows the org-visible hint when the project has no members', async () => {
    getProjectMembers.mockResolvedValue({
      projectId: 'proj-1',
      ownerUserId: 'creator',
      visibility: 'shared',
      restricted: false,
      members: [],
    });
    render(<ProjectMembersSection project={project} />);
    expect(await screen.findByText(/visible to/i)).toBeInTheDocument();
    expect(screen.getByText(/everyone/i)).toBeInTheDocument();
  });

  it('shows the owner-only hint when a private project has no members', async () => {
    getProjectMembers.mockResolvedValue({
      projectId: 'proj-1',
      ownerUserId: 'creator',
      visibility: 'private',
      restricted: false,
      members: [],
    });
    render(<ProjectMembersSection project={{ ...project, visibility: 'private' }} />);
    expect(await screen.findByText(/private project has no assigned members/i)).toBeInTheDocument();
    expect(screen.getByText(/only the creator can see and open it/i)).toBeInTheDocument();
    expect(screen.queryByText(/everyone/i)).not.toBeInTheDocument();
  });

  it('lists members and marks the creator', async () => {
    getProjectMembers.mockResolvedValue({
      projectId: 'proj-1',
      ownerUserId: 'creator',
      visibility: 'shared',
      restricted: true,
      members: [
        { userId: 'creator', username: 'creator', addedBy: 'creator', createdAt: '1' },
        { userId: 'bob', username: 'bob', addedBy: 'creator', createdAt: '2' },
      ],
    });
    render(<ProjectMembersSection project={project} />);
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(screen.getAllByText(/restricted/i).length).toBeGreaterThan(0);
    // "creator" appears as both the username and the creator badge.
    expect(screen.getAllByText('creator').length).toBeGreaterThanOrEqual(2);
  });

  it('shows restricted-empty copy without saying the project is org-visible', async () => {
    getProjectMembers.mockResolvedValue({
      projectId: 'proj-1',
      ownerUserId: 'creator',
      visibility: 'shared',
      restricted: true,
      members: [],
    });
    render(<ProjectMembersSection project={project} />);
    expect(await screen.findByText(/restricted/i)).toBeInTheDocument();
    expect(screen.getByText(/has no assigned users/i)).toBeInTheDocument();
    expect(screen.queryByText(/visible to/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/everyone/i)).not.toBeInTheDocument();
  });

  it('assigns a selected user and reloads', async () => {
    getProjectMembers
      .mockResolvedValueOnce({
        projectId: 'proj-1',
        ownerUserId: 'creator',
        visibility: 'shared',
        restricted: true,
        members: [{ userId: 'creator', username: 'creator', addedBy: null, createdAt: '1' }],
      })
      .mockResolvedValueOnce({
        projectId: 'proj-1',
        ownerUserId: 'creator',
        visibility: 'shared',
        restricted: true,
        members: [
          { userId: 'creator', username: 'creator', addedBy: null, createdAt: '1' },
          { userId: 'bob', username: 'bob', addedBy: 'creator', createdAt: '2' },
        ],
      });
    addProjectMember.mockResolvedValue({ projectId: 'proj-1', userId: 'bob', username: 'bob' });

    render(<ProjectMembersSection project={project} />);
    // bob is assignable (not yet a member); creator is filtered out.
    const select = (await screen.findByTestId('project-member-select-proj-1')) as HTMLSelectElement;
    await waitFor(() => expect(within(select).queryByText('bob')).toBeTruthy());
    fireEvent.change(select, { target: { value: 'bob' } });
    fireEvent.click(screen.getByTestId('project-member-add-proj-1'));
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledWith('proj-1', 'bob'));
    await waitFor(() => expect(getProjectMembers).toHaveBeenCalledTimes(2));
  });

  it('removes a member', async () => {
    getProjectMembers
      .mockResolvedValueOnce({
        projectId: 'proj-1',
        ownerUserId: 'creator',
        visibility: 'shared',
        restricted: true,
        members: [
          { userId: 'creator', username: 'creator', addedBy: null, createdAt: '1' },
          { userId: 'bob', username: 'bob', addedBy: 'creator', createdAt: '2' },
        ],
      })
      .mockResolvedValueOnce({
        projectId: 'proj-1',
        ownerUserId: 'creator',
        visibility: 'shared',
        restricted: true,
        members: [{ userId: 'creator', username: 'creator', addedBy: null, createdAt: '1' }],
      });
    removeProjectMember.mockResolvedValue({ projectId: 'proj-1', userId: 'bob', removed: true });

    render(<ProjectMembersSection project={project} />);
    fireEvent.click(await screen.findByTestId('project-member-remove-bob'));
    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledWith('proj-1', 'bob'));
  });
});
