import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    listApprovalRules: vi.fn(),
    deleteApprovalRule: vi.fn(),
    getMyBrowserProfiles: vi.fn(),
  },
}));

import { api } from '../utils/api';
import ApprovalRulesSection from './ApprovalRulesSection';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function rule(id: string, domain: string, action = 'send') {
  return {
    id,
    profileId: 'prof-1',
    userId: 'u1',
    domain,
    action,
    effect: 'allow',
    sourceRequestId: null,
    createdAt: '2026-10-15 00:00:00',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocked.listApprovalRules.mockResolvedValue({
    rules: [rule('r1', 'mail.example.com'), rule('r2', 'shop.example.com', 'purchase')],
  });
  mocked.getMyBrowserProfiles.mockResolvedValue({
    profiles: [{ id: 'prof-1', agentName: 'Researcher', projectName: 'Hub' }],
  });
  mocked.deleteApprovalRule.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe('ApprovalRulesSection', () => {
  it('lists remembered rules under their browser profile', async () => {
    render(<ApprovalRulesSection />);
    const group = await screen.findByTestId('approval-rules-profile-prof-1');
    await waitFor(() => expect(group).toHaveTextContent('Researcher · Hub'));
    expect(screen.getByTestId('approval-rule-r1')).toHaveTextContent('send on mail.example.com');
    expect(screen.getByTestId('approval-rule-r2')).toHaveTextContent(
      'purchase on shop.example.com',
    );
    expect(screen.getByTestId('approval-rule-r1')).toHaveTextContent('Always allow');
  });

  it('deletes a rule after confirming', async () => {
    render(<ApprovalRulesSection />);
    fireEvent.click(await screen.findByLabelText('Delete rule send on mail.example.com'));
    await waitFor(() => expect(mocked.deleteApprovalRule).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.queryByTestId('approval-rule-r1')).toBeNull());
    expect(screen.getByTestId('approval-rule-r2')).toBeTruthy();
  });

  it('keeps the rule when the delete is cancelled', async () => {
    (window.confirm as any).mockReturnValue(false);
    render(<ApprovalRulesSection />);
    fireEvent.click(await screen.findByLabelText('Delete rule send on mail.example.com'));
    expect(mocked.deleteApprovalRule).not.toHaveBeenCalled();
  });

  it('shows the empty state with no rules', async () => {
    mocked.listApprovalRules.mockResolvedValue({ rules: [] });
    render(<ApprovalRulesSection />);
    expect(await screen.findByTestId('approval-rules-empty')).toBeTruthy();
  });
});
