import { describe, expect, it, vi } from 'vitest';

// The component module imports react-native / HubIcon / the api client at load
// time. Mock them so importing the pure `performDevServerSave` helper doesn't
// pull the RN runtime into the node test env. The helper takes its api as a
// param, so the mocked `api` object is never used by these tests.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../HubIcon', () => ({ default: 'HubIcon' }));
vi.mock('../../utils/api', () => ({ api: {} }));

import {
  performDevServerSave,
  loadDevServerSecrets,
  type DevServerSaveApi,
} from './DevServerSection';
import { emptyDevServerForm, SECRET_MASK, type DevServerForm } from '../../utils/devServerConfig';

/** A promise plus its resolve/reject, so a test can control settle timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadSpies() {
  return {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onSettled: vi.fn(),
  };
}

function baseForm(overrides: Partial<DevServerForm> = {}): DevServerForm {
  return { ...emptyDevServerForm(), startCommand: 'npm run dev', ...overrides };
}

/** Records call order across both api methods so we can assert secrets-first. */
function makeApi(overrides: Partial<DevServerSaveApi> = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const api: DevServerSaveApi = {
    putProjectSecrets: vi.fn((...args: any[]) => {
      calls.push({ method: 'putProjectSecrets', args });
      return Promise.resolve({ secrets: [] });
    }),
    updateProject: vi.fn((...args: any[]) => {
      calls.push({ method: 'updateProject', args });
      return Promise.resolve({});
    }),
    ...overrides,
  };
  return { api, calls };
}

describe('performDevServerSave', () => {
  it('writes secrets before PATCHing the config, masking untouched stored secrets', async () => {
    const { api, calls } = makeApi();
    const form = baseForm({
      startCommand: 'pnpm dev',
      secretRows: [
        // Freshly typed → plaintext written.
        { key: 'STRIPE', value: 'sk_new', hadSecret: true },
        // Untouched stored secret → MASK sentinel, plaintext never re-sent.
        { key: 'DB_PASS', value: '', hadSecret: true },
      ],
      portRows: [{ internalPort: '3000', label: 'web', primary: true }],
    });
    const existing = [
      { key: 'STRIPE', kind: 'secret' as const },
      { key: 'DB_PASS', kind: 'secret' as const },
    ];

    const result = await performDevServerSave(
      api,
      'proj-1',
      { id: 'proj-1', prEnv: { foo: 'bar' } },
      form,
      existing,
    );

    // Secrets PUT ran first, project PATCH second.
    expect(calls.map((c) => c.method)).toEqual(['putProjectSecrets', 'updateProject']);

    const secretsPayload = calls[0].args[1];
    expect(secretsPayload).toContainEqual({ key: 'STRIPE', value: 'sk_new', kind: 'secret' });
    expect(secretsPayload).toContainEqual({ key: 'DB_PASS', value: SECRET_MASK, kind: 'secret' });
    // Plaintext of the untouched secret is never present in the payload.
    expect(JSON.stringify(secretsPayload)).not.toContain('DB_PASS":"sk');

    // PATCH persists devServer under prEnv, preserving sibling prEnv config.
    const patchBody = calls[1].args[1] as any;
    expect(patchBody.prEnv.foo).toBe('bar');
    expect(patchBody.prEnv.devServer).toMatchObject({
      startCommand: 'pnpm dev',
      secretKeys: ['STRIPE', 'DB_PASS'],
      portMap: [{ internalPort: 3000, label: 'web', primary: true }],
    });

    // Merged stored-secret set reflects both referenced keys as stored.
    expect(result.mergedSecrets).toEqual([
      { key: 'STRIPE', kind: 'secret' },
      { key: 'DB_PASS', kind: 'secret' },
    ]);
  });

  it('skips the secrets PUT when no fresh value was typed', async () => {
    const { api } = makeApi();
    const form = baseForm({ secretRows: [{ key: 'TOKEN', value: '', hadSecret: true }] });
    await performDevServerSave(
      api,
      'proj-1',
      { id: 'proj-1' },
      form,
      [{ key: 'TOKEN', kind: 'secret' }],
    );
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
    expect(api.updateProject).toHaveBeenCalledTimes(1);
  });

  it('rolls back written secrets to the pre-save snapshot when the config PATCH fails', async () => {
    const patchError = new Error('patch boom');
    const putProjectSecrets = vi.fn().mockResolvedValue({ secrets: [] });
    const { api } = makeApi({
      putProjectSecrets,
      updateProject: vi.fn().mockRejectedValue(patchError),
    });
    const form = baseForm({
      secretRows: [{ key: 'NEW_SECRET', value: 'fresh', hadSecret: false }],
    });
    const existing = [{ key: 'OLD', kind: 'secret' as const }];

    await expect(
      performDevServerSave(api, 'proj-1', { id: 'proj-1' }, form, existing),
    ).rejects.toThrow('patch boom');

    // First PUT writes the new secret; compensating PUT restores the snapshot.
    expect(putProjectSecrets).toHaveBeenCalledTimes(2);
    const rollbackPayload = putProjectSecrets.mock.calls[1][1];
    expect(rollbackPayload).toEqual([{ key: 'OLD', value: SECRET_MASK, kind: 'secret' }]);
  });

  it('does not attempt rollback when no secrets were written before the PATCH failed', async () => {
    const putProjectSecrets = vi.fn().mockResolvedValue({ secrets: [] });
    const { api } = makeApi({
      putProjectSecrets,
      updateProject: vi.fn().mockRejectedValue(new Error('patch boom')),
    });
    // No fresh secret typed → no secrets PUT, so no rollback either.
    const form = baseForm({ secretRows: [{ key: 'TOKEN', value: '', hadSecret: true }] });

    await expect(
      performDevServerSave(api, 'proj-1', { id: 'proj-1' }, form, [
        { key: 'TOKEN', kind: 'secret' },
      ]),
    ).rejects.toThrow('patch boom');
    expect(putProjectSecrets).not.toHaveBeenCalled();
  });
});

describe('loadDevServerSecrets', () => {
  it('applies the fetched snapshot when the request is still current', async () => {
    const spies = loadSpies();
    await loadDevServerSecrets('proj-1', {
      getProjectSecrets: () => Promise.resolve({ secrets: [{ key: 'A', kind: 'secret' }] }),
      isCurrent: () => true,
      ...spies,
    });
    expect(spies.onSuccess).toHaveBeenCalledWith([{ key: 'A', kind: 'secret' }]);
    expect(spies.onError).not.toHaveBeenCalled();
    expect(spies.onSettled).toHaveBeenCalledTimes(1);
  });

  it('coerces a non-array secrets payload to an empty list', async () => {
    const spies = loadSpies();
    await loadDevServerSecrets('proj-1', {
      getProjectSecrets: () => Promise.resolve({ secrets: null }),
      isCurrent: () => true,
      ...spies,
    });
    expect(spies.onSuccess).toHaveBeenCalledWith([]);
  });

  it('ignores a stale success — a newer load must not be clobbered', async () => {
    const spies = loadSpies();
    // Superseded before the response resolves.
    await loadDevServerSecrets('proj-old', {
      getProjectSecrets: () => Promise.resolve({ secrets: [{ key: 'OLD', kind: 'secret' }] }),
      isCurrent: () => false,
      ...spies,
    });
    expect(spies.onSuccess).not.toHaveBeenCalled();
    expect(spies.onError).not.toHaveBeenCalled();
    // onSettled is also gated, so a stale request never flips `loading` off
    // under the newer request.
    expect(spies.onSettled).not.toHaveBeenCalled();
  });

  it('reports an error only when the failed request is still current', async () => {
    const current = loadSpies();
    await loadDevServerSecrets('proj-1', {
      getProjectSecrets: () => Promise.reject(new Error('boom')),
      isCurrent: () => true,
      ...current,
    });
    expect(current.onError).toHaveBeenCalledTimes(1);
    expect(current.onSettled).toHaveBeenCalledTimes(1);

    const stale = loadSpies();
    await loadDevServerSecrets('proj-old', {
      getProjectSecrets: () => Promise.reject(new Error('boom')),
      isCurrent: () => false,
      ...stale,
    });
    expect(stale.onError).not.toHaveBeenCalled();
    expect(stale.onSettled).not.toHaveBeenCalled();
  });

  it('discards the earlier response when two loads race (project switch mid-flight)', async () => {
    // Mimic the component: a shared generation counter, one id per load.
    let generation = 0;
    const first = deferred<any>();
    const second = deferred<any>();
    const firstSpies = loadSpies();
    const secondSpies = loadSpies();

    const startLoad = (pending: Promise<any>, spies: ReturnType<typeof loadSpies>) => {
      const reqId = ++generation;
      return loadDevServerSecrets('proj', {
        getProjectSecrets: () => pending,
        isCurrent: () => generation === reqId,
        ...spies,
      });
    };

    // Load A (reqId 1) starts, then load B (reqId 2) supersedes it while A is
    // still in flight.
    const pA = startLoad(first.promise, firstSpies);
    const pB = startLoad(second.promise, secondSpies);

    // Resolve the newer request first, then the older one.
    second.resolve({ secrets: [{ key: 'B', kind: 'secret' }] });
    first.resolve({ secrets: [{ key: 'A', kind: 'secret' }] });
    await Promise.all([pA, pB]);

    // Only the newer request's result is applied.
    expect(secondSpies.onSuccess).toHaveBeenCalledWith([{ key: 'B', kind: 'secret' }]);
    expect(secondSpies.onSettled).toHaveBeenCalledTimes(1);
    expect(firstSpies.onSuccess).not.toHaveBeenCalled();
    expect(firstSpies.onSettled).not.toHaveBeenCalled();
  });
});
