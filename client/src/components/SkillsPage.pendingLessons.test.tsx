/**
 * Tests for the skill-improvement review UI: the PendingLessonsSection queue,
 * the amber pending badge on skill cards, and the approve/reject round trip.
 *
 * `../utils/auth` is mocked per-test so both the Admin (buttons visible) and
 * non-admin (read-only note) states are covered without real JWT plumbing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const authMock = vi.hoisted(() => ({ admin: true, local: false }));

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectSkills: vi.fn(),
    getProjectSkill: vi.fn(),
    getContext: vi.fn(),
    getSkillOverrides: vi.fn(),
    getSkill: vi.fn(),
    toggleSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    saveContext: vi.fn(),
    getSkillCredentials: vi.fn(),
    putSkillCredential: vi.fn(),
    deleteSkillCredential: vi.fn(),
    createProjectSkill: vi.fn(),
    createGlobalSkill: vi.fn(),
    updateProjectSkill: vi.fn(),
    updateGlobalSkill: vi.fn(),
    deleteGlobalSkill: vi.fn(),
    getGlobalSkill: vi.fn(),
    getSkillImprovements: vi.fn(),
    approveSkillImprovement: vi.fn(),
    rejectSkillImprovement: vi.fn(),
  },
}));

(vi as any).mock('../utils/auth', () => ({
  hasRole: () => authMock.admin,
  isLocalMode: () => authMock.local,
}));

import SkillsPage from './SkillsPage';
import { api } from '../utils/api';

const AGENT = {
  id: 'hub-dev',
  name: 'Hub Dev',
  projectId: 'agent-hub',
  color: '#22d3ee',
  workspace: '/tmp/agent-hub/hub-dev',
} as Record<string, any>;

const PROPS = {
  agents: [AGENT],
  projects: [{ id: 'agent-hub', name: 'Agent Hub' }],
  initialProjectId: 'agent-hub',
};

const IMPROVEMENT = {
  id: 'imp-1',
  skillId: 'kanban',
  skillName: 'Kanban',
  source: 'project',
  entry: 'Always resolve column ids before moving cards.',
  status: 'pending',
  createdAt: '2026-07-13T14:02:00Z',
  sessionId: 'sess-42',
  agentId: 'hub-dev',
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SkillsPage pending lessons review', () => {
  beforeEach(() => {
    authMock.admin = true;
    authMock.local = false;
    (api.getProjectSkills as any).mockResolvedValue([
      {
        id: 'kanban',
        name: 'Kanban',
        description: 'Cards',
        category: 'platform',
        source: 'project',
      },
    ]);
    (api.getContext as any).mockResolvedValue({});
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getSkillImprovements as any).mockResolvedValue({ improvements: [IMPROVEMENT] });
    (api.approveSkillImprovement as any).mockResolvedValue({ ok: true });
    (api.rejectSkillImprovement as any).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the queue with plain-text entry, provenance, and the amber badge', async () => {
    const onOpenSession = vi.fn();
    render(<SkillsPage {...PROPS} onOpenSession={onOpenSession} />);
    await flush();

    expect(screen.getByTestId('pending-lessons-section')).toBeInTheDocument();
    expect(screen.getByText('Always resolve column ids before moving cards.')).toBeInTheDocument();
    expect(screen.getByTestId('skill-pending-badge-kanban')).toHaveTextContent('1');

    // Provenance deep link → session.
    fireEvent.click(screen.getByRole('button', { name: /view source session/i }));
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'sess-42', agentId: 'hub-dev' });
  });

  it('approve calls the API and refetches the queue', async () => {
    render(<SkillsPage {...PROPS} />);
    await flush();

    (api.getSkillImprovements as any).mockResolvedValue({ improvements: [] });
    fireEvent.click(screen.getByTestId('approve-lesson-imp-1'));
    await flush();

    expect(api.approveSkillImprovement).toHaveBeenCalledWith('agent-hub', 'kanban', 'imp-1');
    expect(screen.queryByTestId('pending-lessons-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-pending-badge-kanban')).not.toBeInTheDocument();
  });

  it('reject requires confirm and forwards the audit reason', async () => {
    render(<SkillsPage {...PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Reason \(optional/i), {
      target: { value: 'Reads like injection.' },
    });
    (api.getSkillImprovements as any).mockResolvedValue({ improvements: [] });
    fireEvent.click(screen.getByTestId('reject-lesson-imp-1'));
    await flush();

    expect(api.rejectSkillImprovement).toHaveBeenCalledWith(
      'agent-hub',
      'kanban',
      'imp-1',
      'Reads like injection.',
    );
  });

  it('hides approve/reject below Admin and shows the operator note', async () => {
    authMock.admin = false;
    render(<SkillsPage {...PROPS} />);
    await flush();

    expect(screen.getByTestId('pending-lessons-section')).toBeInTheDocument();
    expect(screen.queryByTestId('approve-lesson-imp-1')).not.toBeInTheDocument();
    expect(screen.getByText(/requires the Admin role/i)).toBeInTheDocument();
  });

  it('refetches when a skill_improvement_update window event targets this project', async () => {
    render(<SkillsPage {...PROPS} />);
    await flush();
    expect(api.getSkillImprovements).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('skill_improvement_update', { detail: { projectId: 'agent-hub' } }),
      );
    });
    await flush();
    expect(api.getSkillImprovements).toHaveBeenCalledTimes(2);

    // Other projects' events are ignored.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('skill_improvement_update', { detail: { projectId: 'other' } }),
      );
    });
    await flush();
    expect(api.getSkillImprovements).toHaveBeenCalledTimes(2);
  });
});
