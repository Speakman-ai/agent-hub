import { describe, it, expect, vi } from 'vitest';
import {
  applyCollapsedToggle,
  collapsedProjectsCacheKey,
  createCollapsedProjectSaver,
  fromCollapsedMap,
  isCollapsedProjectsCacheKey,
  mergeHydratedCollapsedProjects,
  normalizeCollapsedProjects,
  parseCollapsedProjects,
  SIDEBAR_COLLAPSED_PROJECTS_KEY,
  toCollapsedMap,
} from './sidebarProjectCollapse.js';

describe('parseCollapsedProjects', () => {
  it('parses a well-formed cached payload', () => {
    expect(parseCollapsedProjects('["alpha","beta"]')).toEqual(['alpha', 'beta']);
  });

  it('degrades to an empty list for missing / malformed payloads', () => {
    expect(parseCollapsedProjects(null)).toEqual([]);
    expect(parseCollapsedProjects('')).toEqual([]);
    expect(parseCollapsedProjects('not json')).toEqual([]);
    expect(parseCollapsedProjects('{"alpha":true}')).toEqual([]);
    expect(parseCollapsedProjects('42')).toEqual([]);
  });

  it('drops blanks, non-strings, and duplicates while trimming', () => {
    expect(parseCollapsedProjects('["  alpha  ","","alpha",7,null,"beta"]')).toEqual([
      'alpha',
      'beta',
    ]);
  });
});

describe('normalizeCollapsedProjects', () => {
  it('returns an empty list for non-array input', () => {
    expect(normalizeCollapsedProjects(undefined)).toEqual([]);
    expect(normalizeCollapsedProjects({ alpha: true })).toEqual([]);
  });
});

describe('collapsed map conversions', () => {
  it('round-trips a list through the map form', () => {
    expect(toCollapsedMap(['alpha', 'beta'])).toEqual({ alpha: true, beta: true });
    expect(fromCollapsedMap({ alpha: true, beta: true })).toEqual(['alpha', 'beta']);
  });

  it('drops falsy entries when converting a map back to a list', () => {
    // The sidebar's toggle map keeps `false` entries for projects the user
    // explicitly expanded; those must not be persisted as collapsed.
    expect(fromCollapsedMap({ alpha: true, beta: false })).toEqual(['alpha']);
    expect(fromCollapsedMap(null)).toEqual([]);
  });
});

describe('applyCollapsedToggle', () => {
  it('appends on collapse and is idempotent', () => {
    expect(applyCollapsedToggle([], 'alpha', true)).toEqual(['alpha']);
    expect(applyCollapsedToggle(['alpha'], 'alpha', true)).toEqual(['alpha']);
  });

  it('removes on expand and tolerates an absent id', () => {
    expect(applyCollapsedToggle(['alpha', 'beta'], 'alpha', false)).toEqual(['beta']);
    expect(applyCollapsedToggle(['beta'], 'alpha', false)).toEqual(['beta']);
  });

  it('preserves the order of untouched entries', () => {
    expect(applyCollapsedToggle(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
    expect(applyCollapsedToggle(['a', 'c'], 'b', true)).toEqual(['a', 'c', 'b']);
  });

  it('never mutates the input list', () => {
    const input = ['alpha'];
    applyCollapsedToggle(input, 'beta', true);
    expect(input).toEqual(['alpha']);
  });

  it('ignores a blank project id', () => {
    expect(applyCollapsedToggle(['alpha'], '   ', true)).toEqual(['alpha']);
  });
});

describe('mergeHydratedCollapsedProjects', () => {
  it('takes the server list when there are no pending local edits', () => {
    expect(mergeHydratedCollapsedProjects(['alpha', 'beta'], null)).toEqual(['alpha', 'beta']);
    expect(mergeHydratedCollapsedProjects(['alpha'], {})).toEqual(['alpha']);
  });

  it('keeps a collapse the user made before hydration landed', () => {
    // Regression: without this the click would visibly snap back open when the
    // in-flight GET resolved, and the reverted value is what gets cached next.
    expect(mergeHydratedCollapsedProjects([], { alpha: true })).toEqual(['alpha']);
  });

  it('keeps an expand the user made before hydration landed', () => {
    expect(mergeHydratedCollapsedProjects(['alpha', 'beta'], { alpha: false })).toEqual(['beta']);
  });

  it('leaves projects the user did not touch on the server value', () => {
    expect(mergeHydratedCollapsedProjects(['alpha', 'beta'], { gamma: true })).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('normalizes a malformed server list', () => {
    expect(
      mergeHydratedCollapsedProjects(['alpha', 'alpha', '  beta  '] as string[], null),
    ).toEqual(['alpha', 'beta']);
  });
});

describe('collapsedProjectsCacheKey', () => {
  it('scopes the cache to the account id', () => {
    expect(collapsedProjectsCacheKey({ id: 'u1' })).toBe(`${SIDEBAR_COLLAPSED_PROJECTS_KEY}:u1`);
  });

  it('gives two accounts different keys', () => {
    // The whole point: user B must never paint user A's collapsed projects
    // after an account switch on a shared browser.
    expect(collapsedProjectsCacheKey({ id: 'u1' })).not.toBe(
      collapsedProjectsCacheKey({ id: 'u2' }),
    );
  });

  it('falls back through username then email when id is absent', () => {
    expect(collapsedProjectsCacheKey({ username: 'alice' })).toBe(
      `${SIDEBAR_COLLAPSED_PROJECTS_KEY}:alice`,
    );
    expect(collapsedProjectsCacheKey({ id: '  ', email: 'a@b.c' })).toBe(
      `${SIDEBAR_COLLAPSED_PROJECTS_KEY}:a@b.c`,
    );
  });

  it('falls back to an anonymous bucket with no account (local-bundled)', () => {
    expect(collapsedProjectsCacheKey(null)).toBe(`${SIDEBAR_COLLAPSED_PROJECTS_KEY}:anonymous`);
    expect(collapsedProjectsCacheKey({})).toBe(`${SIDEBAR_COLLAPSED_PROJECTS_KEY}:anonymous`);
  });

  it('recognizes its own keys, including the pre-scoping legacy one', () => {
    expect(isCollapsedProjectsCacheKey(collapsedProjectsCacheKey({ id: 'u1' }))).toBe(true);
    expect(isCollapsedProjectsCacheKey(SIDEBAR_COLLAPSED_PROJECTS_KEY)).toBe(true);
    expect(isCollapsedProjectsCacheKey('sidebarNavGroupsCollapsed')).toBe(false);
    expect(isCollapsedProjectsCacheKey('agent-hub-jwt')).toBe(false);
  });
});

describe('createCollapsedProjectSaver', () => {
  /** A put whose promises resolve only when the test says so. */
  const deferredPut = () => {
    const calls: Array<{ projectId: string; collapsed: boolean; resolve: () => void }> = [];
    const put = vi.fn(
      (projectId: string, collapsed: boolean) =>
        new Promise<void>((resolve) => {
          calls.push({ projectId, collapsed, resolve });
        }),
    );
    return { put, calls };
  };

  it('sends a single toggle straight through', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const saver = createCollapsedProjectSaver(put);
    await saver.save('alpha', true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('alpha', true);
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('never has two requests in flight for the same project', async () => {
    const { put, calls } = deferredPut();
    const saver = createCollapsedProjectSaver(put);

    const first = saver.save('alpha', true);
    saver.save('alpha', false);
    saver.save('alpha', true);
    // Only the first request has gone out; the rest collapsed into `desired`.
    expect(put).toHaveBeenCalledTimes(1);

    calls[0].resolve();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith('alpha', true);
    // Still exactly one outstanding request — the chain is what drains it.
    expect(saver.isSaving('alpha')).toBe(true);

    calls[1].resolve();
    await first;
    expect(put).toHaveBeenCalledTimes(2);
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('leaves the server on the LAST requested value after rapid clicks', async () => {
    // Regression: independent fire-and-forget PUTs could arrive out of order,
    // leaving the account collapsed while the UI showed expanded.
    const { put, calls } = deferredPut();
    const saver = createCollapsedProjectSaver(put);

    const chain = saver.save('alpha', true);
    saver.save('alpha', false);
    saver.save('alpha', true);
    saver.save('alpha', false); // ← the user's final intent

    calls[0].resolve();
    await Promise.resolve();
    // Second request carries the newest value, not the queued intermediates.
    expect(calls[1]).toMatchObject({ projectId: 'alpha', collapsed: false });
    calls[1].resolve();
    await chain;

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.at(-1)).toEqual(['alpha', false]);
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('does not serialize across different projects', async () => {
    const { put } = deferredPut();
    const saver = createCollapsedProjectSaver(put);
    saver.save('alpha', true);
    saver.save('beta', true);
    // Independent projects can't clobber each other, so they go out together.
    expect(put).toHaveBeenCalledTimes(2);
    expect(saver.isSaving('alpha')).toBe(true);
    expect(saver.isSaving('beta')).toBe(true);
  });

  it('keeps draining after a failed request and never rejects', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const saver = createCollapsedProjectSaver(put);

    const chain = saver.save('alpha', true);
    saver.save('alpha', false);
    await expect(chain).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith('alpha', false);
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('cancel discards queued work so it is never dispatched', async () => {
    // Regression: the queue holds VALUES, not requests. A value queued by user
    // A and dispatched after user B signs in would be sent with B's token and
    // written to B's preferences.
    const { put, calls } = deferredPut();
    const saver = createCollapsedProjectSaver(put);

    const chain = saver.save('alpha', true);
    saver.save('alpha', false); // queued behind the in-flight request
    expect(put).toHaveBeenCalledTimes(1);

    saver.cancel(); // ← account changed

    calls[0].resolve();
    await chain;
    // The queued value never went out.
    expect(put).toHaveBeenCalledTimes(1);
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('is inert after cancel', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const saver = createCollapsedProjectSaver(put);
    saver.cancel();
    await saver.save('alpha', true);
    expect(put).not.toHaveBeenCalled();
    expect(saver.isSaving('alpha')).toBe(false);
  });

  it('lets an already-dispatched request settle', async () => {
    // The in-flight PUT was sent with the previous account's credentials, so
    // it lands on the right account — cancelling must not strand its promise.
    const { put, calls } = deferredPut();
    const saver = createCollapsedProjectSaver(put);
    const chain = saver.save('alpha', true);
    saver.cancel();
    calls[0].resolve();
    await expect(chain).resolves.toBeUndefined();
  });

  it('cancel on one saver leaves a replacement saver working', async () => {
    // The account-change path: retire A's saver, build B's, keep saving.
    const putA = vi.fn().mockResolvedValue(undefined);
    const saverA = createCollapsedProjectSaver(putA);
    saverA.cancel();

    const putB = vi.fn().mockResolvedValue(undefined);
    const saverB = createCollapsedProjectSaver(putB);
    await saverB.save('alpha', true);

    expect(putA).not.toHaveBeenCalled();
    expect(putB).toHaveBeenCalledWith('alpha', true);
  });

  it('starts a fresh chain once the previous one has drained', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const saver = createCollapsedProjectSaver(put);
    await saver.save('alpha', true);
    await saver.save('alpha', false);
    expect(put.mock.calls).toEqual([
      ['alpha', true],
      ['alpha', false],
    ]);
  });
});
