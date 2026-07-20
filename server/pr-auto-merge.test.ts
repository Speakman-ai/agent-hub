import { describe, it, expect, vi } from 'vitest';
import {
  setGithubPrAutoMerge,
  mergeMethodToGraphqlEnum,
  ENABLE_AUTO_MERGE_MUTATION,
  DISABLE_AUTO_MERGE_MUTATION,
  type AutoMergeToggleDeps,
} from './pr-auto-merge.js';

function makeDeps(overrides: Partial<AutoMergeToggleDeps> = {}): {
  deps: AutoMergeToggleDeps;
  getPr: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
} {
  const getPr = vi.fn().mockResolvedValue({ node_id: 'PR_node_123' });
  const graphql = vi.fn().mockResolvedValue({ data: {} });
  const deps = { getPr, graphql, ...overrides } as AutoMergeToggleDeps;
  return { deps, getPr, graphql };
}

describe('mergeMethodToGraphqlEnum', () => {
  it('maps to GraphQL enum values', () => {
    expect(mergeMethodToGraphqlEnum('squash')).toBe('SQUASH');
    expect(mergeMethodToGraphqlEnum('merge')).toBe('MERGE');
    expect(mergeMethodToGraphqlEnum('rebase')).toBe('REBASE');
  });
});

describe('setGithubPrAutoMerge', () => {
  it('enables auto-merge with the PR node id and squash enum', async () => {
    const { deps, getPr, graphql } = makeDeps();
    const result = await setGithubPrAutoMerge({
      owner: 'acme',
      repo: 'webapp',
      number: 42,
      enabled: true,
      mergeMethod: 'squash',
      deps,
    });

    expect(getPr).toHaveBeenCalledWith('acme', 'webapp', 42);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: 'PR_node_123',
      mergeMethod: 'SQUASH',
    });
    expect(result).toEqual({ enabled: true, mergeMethod: 'squash', nodeId: 'PR_node_123' });
  });

  it('passes the requested merge method through as the GraphQL enum', async () => {
    const { deps, graphql } = makeDeps();
    await setGithubPrAutoMerge({
      owner: 'acme',
      repo: 'webapp',
      number: 7,
      enabled: true,
      mergeMethod: 'merge',
      deps,
    });
    expect(graphql).toHaveBeenCalledWith(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: 'PR_node_123',
      mergeMethod: 'MERGE',
    });
  });

  it('disables auto-merge with only the node id (no merge method)', async () => {
    const { deps, graphql } = makeDeps();
    const result = await setGithubPrAutoMerge({
      owner: 'acme',
      repo: 'webapp',
      number: 42,
      enabled: false,
      mergeMethod: 'squash',
      deps,
    });
    expect(graphql).toHaveBeenCalledWith(DISABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: 'PR_node_123',
    });
    expect(result.enabled).toBe(false);
  });

  it('throws when GitHub does not return a node id', async () => {
    const { deps, graphql } = makeDeps({
      getPr: vi.fn().mockResolvedValue({ number: 42 }) as AutoMergeToggleDeps['getPr'],
    });
    await expect(
      setGithubPrAutoMerge({
        owner: 'acme',
        repo: 'webapp',
        number: 42,
        enabled: true,
        mergeMethod: 'squash',
        deps,
      }),
    ).rejects.toThrow(/node id/i);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('propagates GraphQL failures (e.g. auto-merge not allowed on the repo)', async () => {
    const { deps } = makeDeps({
      graphql: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub GraphQL errors: Auto merge is not allowed for this repository'),
        ) as AutoMergeToggleDeps['graphql'],
    });
    await expect(
      setGithubPrAutoMerge({
        owner: 'acme',
        repo: 'webapp',
        number: 42,
        enabled: true,
        mergeMethod: 'squash',
        deps,
      }),
    ).rejects.toThrow(/Auto merge is not allowed/);
  });
});
