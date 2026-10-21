import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { select: (o: any) => o.default },
  Text: 'Text',
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
}));
const getDefaultBranchHealth = vi.fn();
// Reads that should fail go through `failingProjects` instead of a rejecting
// vi.fn implementation, which vitest's mock bookkeeping reports as unhandled.
const failingProjects = new Set<string>();
vi.mock('../utils/api', () => ({
  api: {
    getDefaultBranchHealth: (id: string) => {
      const result = getDefaultBranchHealth(id);
      return failingProjects.has(id) ? Promise.reject(new Error('offline')) : result;
    },
  },
}));

const { DefaultBranchHealthBanner } = await import('./TestSelectionViews');

const green = { state: 'green', branch: 'main', breakage: null, failures: [] };
const red = {
  state: 'red',
  branch: 'main',
  breakage: { id: 'b1', card_id: 'card-1', first_failing_sha: 'c'.repeat(40) },
  failures: [
    { job_id: 'server', matrix_key: '', first_failing_sha: 'c'.repeat(40), last_failing_sha: 'c' },
  ],
};

const hasBanner = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.props?.testID === 'default-branch-red-banner').length > 0;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('mobile DefaultBranchHealthBanner refresh', () => {
  beforeEach(() => {
    getDefaultBranchHealth.mockReset();
    failingProjects.clear();
  });

  it('follows green -> red -> green as the refresh key changes, without remounting', async () => {
    getDefaultBranchHealth.mockResolvedValue(green);
    let r!: ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <DefaultBranchHealthBanner projectId="p1" refreshKey="a:running" pollMs={0} />,
      );
    });
    await flush();
    expect(hasBanner(r)).toBe(false);

    getDefaultBranchHealth.mockResolvedValue(red);
    act(() => {
      r.update(<DefaultBranchHealthBanner projectId="p1" refreshKey="a:failed" pollMs={0} />);
    });
    await flush();
    expect(hasBanner(r)).toBe(true);

    getDefaultBranchHealth.mockResolvedValue(green);
    act(() => {
      r.update(
        <DefaultBranchHealthBanner projectId="p1" refreshKey="a:failed,b:succeeded" pollMs={0} />,
      );
    });
    await flush();
    expect(hasBanner(r)).toBe(false);
    expect(getDefaultBranchHealth).toHaveBeenCalledTimes(3);
  });

  it('drops the previous project red banner when the new project read fails', async () => {
    getDefaultBranchHealth.mockResolvedValue(red);
    failingProjects.add('p2');
    let r!: ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<DefaultBranchHealthBanner projectId="p1" pollMs={0} />);
    });
    await flush();
    expect(hasBanner(r)).toBe(true);

    act(() => {
      r.update(<DefaultBranchHealthBanner projectId="p2" pollMs={0} />);
    });
    expect(hasBanner(r)).toBe(false);
    await flush();
    expect(getDefaultBranchHealth).toHaveBeenCalledWith('p2');
    expect(hasBanner(r)).toBe(false);
  });
});
