import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => { update: (el: any) => void };

const apiMock = vi.hoisted(() => ({
  getSkillImprovements: vi.fn<(projectId: string, status?: string) => Promise<any>>(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { usePendingLessonTotal } = await import('./usePendingLessonTotal');

/** Fake a pending-lessons response with `n` entries. */
function improvements(n: number) {
  return { improvements: Array.from({ length: n }, (_, i) => ({ id: String(i) })) };
}

type Props = { projects: Array<{ id?: string | null }>; refreshKey: number };

function harness() {
  let latest = 0;
  function Harness({ projects, refreshKey }: Props) {
    latest = usePendingLessonTotal(projects, refreshKey);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  return {
    get value() {
      return latest;
    },
    async render(props: Props) {
      await act(async () => {
        renderer = create(<Harness {...props} />);
        await flushMicrotasks();
      });
    },
    async update(props: Props) {
      await act(async () => {
        renderer.update(<Harness {...props} />);
        await flushMicrotasks();
      });
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('usePendingLessonTotal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums the pending counts across all projects on load', async () => {
    apiMock.getSkillImprovements.mockImplementation((pid: string) =>
      Promise.resolve(improvements(pid === 'a' ? 3 : 2)),
    );
    const h = harness();
    await h.render({ projects: [{ id: 'a' }, { id: 'b' }], refreshKey: 0 });
    expect(h.value).toBe(5);
  });

  // Reviewer finding 2: a transient failure during a refresh must NOT zero the
  // total — the previously known count for the failing project is preserved.
  it('preserves the last known total when a later refresh fails for one project', async () => {
    apiMock.getSkillImprovements.mockImplementation((pid: string) =>
      Promise.resolve(improvements(pid === 'a' ? 3 : 2)),
    );
    const h = harness();
    await h.render({ projects: [{ id: 'a' }, { id: 'b' }], refreshKey: 0 });
    expect(h.value).toBe(5);

    // WS-triggered refresh: 'a' now has 4, 'b' fails transiently.
    apiMock.getSkillImprovements.mockImplementation((pid: string) =>
      pid === 'a' ? Promise.resolve(improvements(4)) : Promise.reject(new Error('boom')),
    );
    await h.update({ projects: [{ id: 'a' }, { id: 'b' }], refreshKey: 1 });

    // 4 (fresh a) + 2 (preserved b), NOT 4 + 0.
    expect(h.value).toBe(6);
  });

  it('prunes a departed project from the total after an org switch', async () => {
    apiMock.getSkillImprovements.mockImplementation((pid: string) =>
      Promise.resolve(improvements(pid === 'a' ? 3 : 2)),
    );
    const h = harness();
    await h.render({ projects: [{ id: 'a' }, { id: 'b' }], refreshKey: 0 });
    expect(h.value).toBe(5);

    // 'b' leaves the project list; its 2 must drop out of the total.
    await h.update({ projects: [{ id: 'a' }], refreshKey: 0 });
    expect(h.value).toBe(3);
  });

  it('is 0 with no projects', async () => {
    const h = harness();
    await h.render({ projects: [], refreshKey: 0 });
    expect(h.value).toBe(0);
    expect(apiMock.getSkillImprovements).not.toHaveBeenCalled();
  });
});
