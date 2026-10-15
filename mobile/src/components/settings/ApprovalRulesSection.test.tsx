import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  alert: vi.fn(),
  api: { listApprovalRules: vi.fn(), deleteApprovalRule: vi.fn(), getMyBrowserProfiles: vi.fn() },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: testState.alert },
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('../../utils/api', () => ({ api: testState.api }));

const { default: ApprovalRulesSection } = await import('./ApprovalRulesSection');

function rule(id: string, domain: string) {
  return {
    id,
    profileId: 'prof-1',
    userId: 'u1',
    domain,
    action: 'send',
    effect: 'allow',
    sourceRequestId: null,
    createdAt: '2026-10-15 00:00:00',
  };
}

async function render() {
  let r!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    r = TestRenderer.create(<ApprovalRulesSection />);
  });
  await TestRenderer.act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return r;
}

const byTestId = (r: ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id && typeof n.type === 'string');

const allText = (r: ReactTestRenderer) =>
  r.root
    .findAllByType('Text' as any)
    .flatMap((t) => [].concat(t.props.children))
    .filter((c) => typeof c === 'string')
    .join(' | ');

describe('mobile ApprovalRulesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.api.listApprovalRules.mockResolvedValue({
      rules: [rule('r1', 'mail.example.com'), rule('r2', 'shop.example.com')],
    });
    testState.api.getMyBrowserProfiles.mockResolvedValue({
      profiles: [{ id: 'prof-1', agentName: 'Researcher', projectName: 'Hub' }],
    });
    testState.api.deleteApprovalRule.mockResolvedValue({ ok: true });
  });

  it('lists rules under their profile label', async () => {
    const r = await render();
    expect(byTestId(r, 'approval-rules-profile-prof-1')).toHaveLength(1);
    const text = allText(r);
    expect(text).toContain('Researcher · Hub');
    expect(text).toContain('send on mail.example.com');
    expect(text).toContain('Always allow');
  });

  it('deletes a rule after the confirm alert', async () => {
    const r = await render();
    byTestId(r, 'approval-rule-delete-r1')[0].props.onPress();
    expect(testState.alert).toHaveBeenCalled();
    const buttons = testState.alert.mock.calls[0][2];
    await TestRenderer.act(async () => {
      buttons.find((b: any) => b.text === 'Delete').onPress();
    });
    expect(testState.api.deleteApprovalRule).toHaveBeenCalledWith('r1');
    expect(byTestId(r, 'approval-rule-r1')).toHaveLength(0);
    expect(byTestId(r, 'approval-rule-r2')).toHaveLength(1);
  });

  it('shows the empty state', async () => {
    testState.api.listApprovalRules.mockResolvedValue({ rules: [] });
    const r = await render();
    expect(byTestId(r, 'approval-rules-empty')).toHaveLength(1);
  });
});
