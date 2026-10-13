import { describe, expect, it, vi, beforeEach } from 'vitest';

// Vitest inherits NODE_ENV=production in Agent Hub's test runner. Load the
// development React renderer explicitly so hooks flush interactively.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
const api = vi.hoisted(() => ({
  getProjectPrEnvironments: vi.fn(),
  updateProjectPrEnvironmentLimits: vi.fn(),
  stopPullPreview: vi.fn(),
}));
vi.mock('../../utils/api', () => ({ api }));

const { default: PrEnvironmentsPanel, limitsPatchFrom } = await import('./PrEnvironmentsPanel');

const LIMITS = { maxConcurrent: 5, idleTtlMinutes: 60, maxLifetimeDays: 14 };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const text = (node: any): string =>
  node
    .findAll((n: any) => n.type === 'Text')
    .map((n: any) => n.children.join(''))
    .join(' ');

describe('PrEnvironmentsPanel (mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProjectPrEnvironments.mockResolvedValue({
      limits: LIMITS,
      overrides: {},
      defaults: LIMITS,
      environments: [
        {
          id: 'e1',
          prNumber: 12,
          status: 'ready',
          createdAt: ago(3 * 86_400_000),
          lastHitAt: ago(600_000),
        },
        { id: 'e2', prNumber: 7, status: 'stopped', stopReason: 'idle', createdAt: ago(3_600_000) },
      ],
    });
  });

  it('lists envs with status, age, last hit; Stop only where something runs', async () => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<PrEnvironmentsPanel projectId="p" />);
    });
    await flush();
    const ready = r.root.findByProps({ testID: 'pr-env-row-12' });
    expect(text(ready)).toContain('age 3d · last hit 10m');
    expect(text(r.root.findByProps({ testID: 'pr-env-row-7' }))).toContain('asleep');
    expect(r.root.findAllByProps({ testID: 'pr-env-stop-7' })).toHaveLength(0);

    api.stopPullPreview.mockResolvedValue({ ok: true });
    await act(async () => {
      r.root.findByProps({ testID: 'pr-env-stop-12' }).props.onPress();
    });
    await flush();
    expect(api.stopPullPreview).toHaveBeenCalledWith('p', 12);
    expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(2);
  });
});

describe('limitsPatchFrom', () => {
  it('sends changed values, resets emptied overrides, and rejects non-integers', () => {
    const data = { limits: { ...LIMITS, idleTtlMinutes: 30 }, overrides: { idleTtlMinutes: 30 } };
    expect(
      limitsPatchFrom(data, { maxConcurrent: '2', idleTtlMinutes: '', maxLifetimeDays: '14' }),
    ).toEqual({ patch: { maxConcurrent: 2, idleTtlMinutes: null } });
    expect(
      limitsPatchFrom(data, { maxConcurrent: '1.5', idleTtlMinutes: '30', maxLifetimeDays: '14' }),
    ).toHaveProperty('error');
  });
});

describe('PrEnvironmentsPanel (mobile) project switch', () => {
  it('a late response for the previous project never fills the new one, and Stop targets the new project', async () => {
    vi.clearAllMocks();
    let resolveA!: (v: unknown) => void;
    const data = (prNumber: number) => ({
      limits: LIMITS,
      overrides: {},
      defaults: LIMITS,
      environments: [{ id: `e${prNumber}`, prNumber, status: 'ready', createdAt: ago(60_000) }],
    });
    api.getProjectPrEnvironments.mockImplementation((id: string) =>
      id === 'A' ? new Promise((r) => (resolveA = r)) : Promise.resolve(data(2)),
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<PrEnvironmentsPanel projectId="A" />);
    });
    await act(async () => {
      r.update(<PrEnvironmentsPanel projectId="B" />);
    });
    await flush();
    await act(async () => resolveA(data(1)));
    await flush();
    expect(r.root.findAllByProps({ testID: 'pr-env-row-1' })).toHaveLength(0);
    api.stopPullPreview.mockResolvedValue({ ok: true });
    await act(async () => {
      r.root.findByProps({ testID: 'pr-env-stop-2' }).props.onPress();
    });
    expect(api.stopPullPreview).toHaveBeenCalledWith('B', 2);
  });
});

describe('PrEnvironmentsPanel (mobile) refresh racing a save', () => {
  it('Save then Refresh: the refresh is sent after the save completes and shows the saved limits', async () => {
    vi.clearAllMocks();
    const server = { maxConcurrent: LIMITS.maxConcurrent, finishPut: null as null | (() => void) };
    const body = () => ({
      limits: { ...LIMITS, maxConcurrent: server.maxConcurrent },
      overrides: {},
      defaults: LIMITS,
      environments: [],
    });
    api.getProjectPrEnvironments.mockImplementation(async () => body());
    api.updateProjectPrEnvironmentLimits.mockImplementation(
      (_id: string, patch: { maxConcurrent?: number }) =>
        new Promise((resolve) => {
          server.finishPut = () => {
            if (patch.maxConcurrent != null) server.maxConcurrent = patch.maxConcurrent;
            resolve(body());
          };
        }),
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<PrEnvironmentsPanel projectId="p" />);
    });
    await flush();
    await act(async () =>
      r.root.findByProps({ testID: 'pr-env-limit-maxConcurrent' }).props.onChangeText('2'),
    );
    await act(async () => r.root.findByProps({ testID: 'pr-env-limits-save' }).props.onPress());
    await flush();
    const refresh = r.root
      .findAll((n: any) => n.type === 'TouchableOpacity')
      .find((n: any) => text(n).includes('Refresh'));
    await act(async () => refresh.props.onPress());
    await flush();
    expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(1);
    await act(async () => server.finishPut!());
    await flush();
    await flush();
    expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(2);
    expect(r.root.findByProps({ testID: 'pr-env-limit-maxConcurrent' }).props.value).toBe('2');
  });
});
