import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  api: { listMyApprovals: vi.fn(), answerApproval: vi.fn() },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('../utils/api', () => ({ api: testState.api }));

const { default: SessionApprovalCard } = await import('./SessionApprovalCard');
const { approvalEvents } = await import('../utils/approvalEvents');

function approval(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 's1',
    agentId: 'a1',
    projectId: 'p1',
    action: 'send',
    target: 'email to ann',
    domain: 'mail.example.com',
    details: 'Q3 numbers',
    status: 'pending',
    resolution: null,
    ruleId: null,
    canRemember: true,
    requestedAt: 1,
    expiresAt: Date.now() + 2 * 3_600_000 + 60_000,
    resolvedAt: null,
    ...over,
  };
}

async function flush() {
  await TestRenderer.act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function render(el: any) {
  let r!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    r = TestRenderer.create(el);
  });
  await flush();
  return r;
}

const allText = (r: ReactTestRenderer) =>
  r.root
    .findAllByType('Text' as any)
    .flatMap((t) => [].concat(t.props.children))
    .filter((c) => typeof c === 'string')
    .join(' ');

const byTestId = (r: ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id && typeof n.type === 'string');

describe('SessionApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.api.listMyApprovals.mockResolvedValue({ approvals: [approval('ap1')] });
    testState.api.answerApproval.mockResolvedValue({ approval: approval('ap1'), ruleId: null });
  });

  it('renders the pending request with all three answers', async () => {
    const r = await render(<SessionApprovalCard sessionId="s1" />);
    expect(testState.api.listMyApprovals).toHaveBeenCalledWith({
      status: 'pending',
      sessionId: 's1',
    });
    const text = allText(r);
    expect(text).toContain('send email to ann');
    expect(text).toContain('Q3 numbers');
    expect(text).toContain('expires in 2h');
    expect(byTestId(r, 'session-approval-allow_once')).toHaveLength(1);
    expect(byTestId(r, 'session-approval-always_allow')).toHaveLength(1);
    expect(byTestId(r, 'session-approval-deny')).toHaveLength(1);
  });

  it('renders nothing with no pending approvals or no session', async () => {
    testState.api.listMyApprovals.mockResolvedValue({ approvals: [] });
    const r = await render(<SessionApprovalCard sessionId="s1" />);
    expect(byTestId(r, 'session-approval-card')).toHaveLength(0);
    const none = await render(<SessionApprovalCard sessionId={null} />);
    expect(byTestId(none, 'session-approval-card')).toHaveLength(0);
  });

  it('answers and removes the card', async () => {
    const r = await render(<SessionApprovalCard sessionId="s1" />);
    await TestRenderer.act(async () => {
      byTestId(r, 'session-approval-deny')[0].props.onPress();
    });
    await flush();
    expect(testState.api.answerApproval).toHaveBeenCalledWith('ap1', 'deny');
    expect(byTestId(r, 'session-approval-card')).toHaveLength(0);
  });

  it('drops the card when the approval resolves elsewhere', async () => {
    const r = await render(<SessionApprovalCard sessionId="s1" />);
    await TestRenderer.act(async () => {
      approvalEvents.emit({ type: 'approval_resolved', sessionId: 's1', approvalId: 'ap1' });
    });
    expect(byTestId(r, 'session-approval-card')).toHaveLength(0);
  });
});
