import { describe, expect, it, vi } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createUseSessionFolders, type SessionFoldersApi } from '@shared/hooks/useSessionFolders';

const useSessionFolders = createUseSessionFolders({ useState, useRef, useCallback });

const folder = (id: string, position = 0) => ({
  id,
  agentId: 'a1',
  name: id,
  position,
  createdAt: '2026-01-01 00:00:00',
});

function fakeApi(overrides: Partial<SessionFoldersApi> = {}) {
  const api: SessionFoldersApi = {
    getSessionFolders: vi
      .fn()
      .mockResolvedValue({ folders: [folder('f1')], assignments: { s1: 'f1' } }),
    createSessionFolder: vi.fn().mockResolvedValue({ folder: folder('f2', 1) }),
    renameSessionFolder: vi.fn().mockResolvedValue({}),
    deleteSessionFolder: vi.fn().mockResolvedValue({ ok: true }),
    setSessionFolder: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  return api;
}

describe('useSessionFolders', () => {
  it('loads each agent once and applies writes locally', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useSessionFolders(api));
    act(() => {
      result.current.loadFolders('a1');
      result.current.loadFolders('a1');
    });
    await waitFor(() => expect(result.current.foldersByAgentId.a1?.folders).toHaveLength(1));
    expect(api.getSessionFolders).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.createFolder('a1', 'f2');
    });
    expect(result.current.foldersByAgentId.a1.folders.map((f) => f.id)).toEqual(['f1', 'f2']);

    await act(async () => {
      await result.current.moveSession('a1', 's2', 'f2');
    });
    expect(result.current.foldersByAgentId.a1.assignments).toEqual({ s1: 'f1', s2: 'f2' });
    expect(api.setSessionFolder).toHaveBeenCalledWith('s2', 'f2');

    await act(async () => {
      await result.current.renameFolder('a1', 'f1', 'Infra');
    });
    expect(result.current.foldersByAgentId.a1.folders[0].name).toBe('Infra');

    await act(async () => {
      await result.current.deleteFolder('a1', 'f1');
    });
    expect(result.current.foldersByAgentId.a1.folders.map((f) => f.id)).toEqual(['f2']);
    expect(result.current.foldersByAgentId.a1.assignments).toEqual({ s2: 'f2' });
  });

  it('reloads from the server when a move fails', async () => {
    const api = fakeApi({ setSessionFolder: vi.fn().mockRejectedValue(new Error('nope')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useSessionFolders(api));
    act(() => result.current.loadFolders('a1'));
    await waitFor(() => expect(result.current.foldersByAgentId.a1).toBeDefined());

    await act(async () => {
      await result.current.moveSession('a1', 's1', null);
    });
    await waitFor(() =>
      expect(result.current.foldersByAgentId.a1.assignments).toEqual({ s1: 'f1' }),
    );
    expect(api.getSessionFolders).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('applies a create made while the first load is in flight, then reconciles', async () => {
    let resolveStale!: (v: unknown) => void;
    const getSessionFolders = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (resolveStale = res)))
      .mockResolvedValue({ folders: [folder('f1'), folder('f2', 1)], assignments: {} });
    const api = fakeApi({ getSessionFolders });
    const { result } = renderHook(() => useSessionFolders(api));
    act(() => result.current.loadFolders('a1'));
    await waitFor(() => expect(getSessionFolders).toHaveBeenCalledTimes(1));

    let creating!: Promise<unknown>;
    act(() => {
      creating = result.current.createFolder('a1', 'f2');
    });
    // Queued behind the load: the create request has not gone out yet.
    expect(api.createSessionFolder).not.toHaveBeenCalled();

    // The load resolves with a listing that predates the create.
    await act(async () => {
      resolveStale({ folders: [folder('f1')], assignments: {} });
      await creating;
    });
    await waitFor(() => expect(getSessionFolders).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.foldersByAgentId.a1.folders.map((f) => f.id)).toEqual(['f1', 'f2']),
    );
  });

  it('sends two quick moves of one session in order so the last choice is what is stored', async () => {
    const finish: Array<(v: unknown) => void> = [];
    const setSessionFolder = vi.fn(() => new Promise((res) => finish.push(res)));
    const api = fakeApi({ setSessionFolder });
    const { result } = renderHook(() => useSessionFolders(api));
    act(() => result.current.loadFolders('a1'));
    await waitFor(() => expect(result.current.foldersByAgentId.a1).toBeDefined());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.moveSession('a1', 's1', 'fA');
      second = result.current.moveSession('a1', 's1', 'fB');
    });
    expect(result.current.foldersByAgentId.a1.assignments.s1).toBe('fB');
    // The second request waits for the first, so the server cannot apply them reversed.
    await waitFor(() => expect(setSessionFolder).toHaveBeenCalledTimes(1));
    expect(setSessionFolder).toHaveBeenLastCalledWith('s1', 'fA');

    await act(async () => {
      finish[0]({});
      await first;
    });
    await waitFor(() => expect(setSessionFolder).toHaveBeenCalledTimes(2));
    expect(setSessionFolder).toHaveBeenLastCalledWith('s1', 'fB');
    await act(async () => {
      finish[1]({});
      await second;
    });
    expect(result.current.foldersByAgentId.a1.assignments.s1).toBe('fB');
  });

  it('keeps an optimistic rename when an earlier load lands before the rename is sent', async () => {
    let resolveStale!: (v: unknown) => void;
    const getSessionFolders = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (resolveStale = res)))
      .mockResolvedValue({ folders: [{ ...folder('f1'), name: 'Infra' }], assignments: {} });
    const api = fakeApi({ getSessionFolders });
    const { result } = renderHook(() => useSessionFolders(api));
    act(() => result.current.loadFolders('a1'));
    await waitFor(() => expect(getSessionFolders).toHaveBeenCalledTimes(1));

    let renaming!: Promise<void>;
    act(() => {
      renaming = result.current.renameFolder('a1', 'f1', 'Infra');
    });
    await act(async () => {
      resolveStale({ folders: [folder('f1')], assignments: {} });
    });
    expect(result.current.foldersByAgentId.a1.folders[0].name).toBe('Infra');
    await act(async () => {
      await renaming;
    });
    await waitFor(() => expect(getSessionFolders).toHaveBeenCalledTimes(2));
    expect(result.current.foldersByAgentId.a1.folders[0].name).toBe('Infra');
  });
});
