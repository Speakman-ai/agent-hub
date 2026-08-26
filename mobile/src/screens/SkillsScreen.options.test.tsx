import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer's async act path requires a non-production build flag.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => any;

// Render RN primitives as plain string-tag hosts so react-test-renderer can
// serialize/traverse the tree without a native runtime (same approach as the
// SkillsScreen.credentials.test.tsx sibling).
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Linking: { openURL: () => {} },
  StyleSheet: {
    create: (styles: any) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../utils/auth', () => ({ hasRole: () => true, getUserRole: () => 'Admin' }));

const apiMock = vi.hoisted(() => ({
  getSkillOptions: vi.fn<(skillId: string, agentId?: string) => Promise<any>>(),
  putSkillOption: vi.fn<(body: any) => Promise<any>>(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { SkillOptionsSection } = await import('./SkillsScreen');

const OPTIONS = {
  options: [
    {
      name: 'environment',
      label: 'Environment',
      description: 'Which deployment target the skill runs against.',
      choices: [
        { value: 'dev', label: 'Development' },
        { value: 'prod', label: 'Production' },
      ],
      default: 'dev',
      required: true,
      selected: 'dev',
    },
  ],
};

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Depth-first search for a host node matching a testID prop. */
function findByTestId(node: any, testID: string): any {
  const found = node.root.findAll((n: any) => n.props && n.props.testID === testID, { deep: true });
  return found[0];
}

describe('SkillsScreen — SkillOptionsSection mobile parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSkillOptions.mockResolvedValue(OPTIONS);
    apiMock.putSkillOption.mockResolvedValue({ option: {} });
  });

  it('fetches options on mount and renders a choice chip per declared value', async () => {
    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="deploy" agentId="agent-1" />);
      await flushMicrotasks();
    });
    expect(apiMock.getSkillOptions).toHaveBeenCalledWith('deploy', 'agent-1');
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('Options');
    expect(html).toContain('Environment');
    expect(html).toContain('Which deployment target the skill runs against.');
    expect(html).toContain('Development');
    expect(html).toContain('Production');
    // Both declared choices render as tappable chips.
    expect(findByTestId(renderer, 'skill-option-choice-environment-dev')).toBeTruthy();
    expect(findByTestId(renderer, 'skill-option-choice-environment-prod')).toBeTruthy();
  });

  it('persists a pick via putSkillOption and refetches when a chip is tapped', async () => {
    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="deploy" agentId="agent-1" />);
      await flushMicrotasks();
    });
    const prodChip = findByTestId(renderer, 'skill-option-choice-environment-prod');
    await act(async () => {
      prodChip.props.onPress();
      await flushMicrotasks();
    });
    expect(apiMock.putSkillOption).toHaveBeenCalledWith({
      skill_id: 'deploy',
      option_name: 'environment',
      value: 'prod',
      agent_id: 'agent-1',
    });
    // Refetch after a successful write (initial load + post-write reload).
    expect(apiMock.getSkillOptions).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when no options are declared', async () => {
    apiMock.getSkillOptions.mockResolvedValue({ options: [] });
    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="deploy" agentId="agent-1" />);
      await flushMicrotasks();
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('drops a stale fetch when the skill changes mid-flight (no cross-skill leak)', async () => {
    // Root-cause regression: an in-flight load for skill A must not apply once
    // the section is rendering skill B. Resolve A's request LAST and assert B's
    // options win.
    let resolveA!: (v: any) => void;
    const aPending = new Promise((r) => {
      resolveA = r;
    });
    apiMock.getSkillOptions.mockImplementationOnce(() => aPending); // first call (skill A)
    apiMock.getSkillOptions.mockResolvedValueOnce({
      options: [
        {
          name: 'region',
          label: 'Region',
          description: 'B-only option',
          choices: [{ value: 'us', label: 'US' }],
          default: 'us',
          required: false,
          selected: 'us',
        },
      ],
    }); // second call (skill B)

    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="skill-a" agentId="agent-1" />);
      await flushMicrotasks();
    });
    // Switch to skill B; its request resolves immediately.
    await act(async () => {
      renderer.update(<SkillOptionsSection skillId="skill-b" agentId="agent-1" />);
      await flushMicrotasks();
    });
    // Now resolve the stale skill-A request.
    await act(async () => {
      resolveA(OPTIONS); // A's payload has the `environment` option
      await flushMicrotasks();
    });

    const html = JSON.stringify(renderer.toJSON());
    // B's option is shown; A's stale payload did NOT overwrite it.
    expect(html).toContain('Region');
    expect(html).not.toContain('Environment');
  });

  it('clears the previous skill options immediately on switch (no stale chips before new load)', async () => {
    // Root-cause regression: switching skill drops the old options
    // synchronously; a stale chip must not linger while the new load is pending.
    apiMock.getSkillOptions.mockResolvedValueOnce(OPTIONS); // skill A → environment
    apiMock.getSkillOptions.mockReturnValueOnce(new Promise(() => {})); // skill B → pending
    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="skill-a" agentId="agent-1" />);
      await flushMicrotasks();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Environment');
    await act(async () => {
      renderer.update(<SkillOptionsSection skillId="skill-b" agentId="agent-1" />);
      await flushMicrotasks();
    });
    // A's option is gone while B is still loading (not resolved).
    expect(JSON.stringify(renderer.toJSON() ?? '')).not.toContain('Environment');
  });

  it('surfaces the error when the initial fetch fails (not silently hidden)', async () => {
    // Regression: `if (!options.length) return null` used to hide the error UI
    // too, making a failed fetch indistinguishable from a no-options skill.
    apiMock.getSkillOptions.mockRejectedValue(new Error('boom-options'));
    let renderer!: any;
    await act(async () => {
      renderer = create(<SkillOptionsSection skillId="deploy" agentId="agent-1" />);
      await flushMicrotasks();
    });
    expect(renderer.toJSON()).not.toBeNull();
    expect(JSON.stringify(renderer.toJSON())).toContain('boom-options');
  });
});
