// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { createReloadMessages } from './sessionReload';
describe('createReloadMessages', () => {
    it('clears messages and resolves [] when no session is active', async () => {
        const setMessages = vi.fn();
        const fetchMessages = vi.fn();
        const reload = createReloadMessages({
            fetchMessages,
            getActiveSessionId: () => null,
            setMessages,
        });
        const result = await reload();
        expect(result).toEqual([]);
        expect(setMessages).toHaveBeenCalledWith([]);
        expect(fetchMessages).not.toHaveBeenCalled();
    });
    it('fetches and applies messages for the active session', async () => {
        const messages = [{ id: 'm1', role: 'user', content: 'hi' }];
        const setMessages = vi.fn();
        const fetchMessages = vi.fn().mockResolvedValue(messages);
        const reload = createReloadMessages({
            fetchMessages,
            getActiveSessionId: () => 'session-a',
            setMessages,
        });
        const result = await reload();
        expect(fetchMessages).toHaveBeenCalledWith('session-a');
        expect(setMessages).toHaveBeenCalledWith(messages);
        expect(result).toBe(messages);
    });
    it('discards the response if the active session changed mid-flight', async () => {
        const messages = [{ id: 'm1' }];
        const setMessages = vi.fn();
        let activeSid = 'session-a';
        const fetchMessages = vi.fn().mockImplementation(() => new Promise((resolve: any) => {
            // Simulate the user swapping sessions before the fetch resolves.
            activeSid = 'session-b';
            resolve(messages);
        }));
        const reload = createReloadMessages({
            fetchMessages,
            getActiveSessionId: () => activeSid,
            setMessages,
        });
        const result = await reload();
        // Neither the stale data nor an empty array should be written — the
        // session-b path will issue its own fetch.
        expect(setMessages).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });
    it('clears messages when the fetch rejects for the still-active session', async () => {
        const setMessages = vi.fn();
        const fetchMessages = vi.fn().mockRejectedValue(new Error('network down'));
        const reload = createReloadMessages({
            fetchMessages,
            getActiveSessionId: () => 'session-a',
            setMessages,
        });
        const result = await reload();
        expect(setMessages).toHaveBeenCalledWith([]);
        expect(result).toEqual([]);
    });
    it('swallows fetch errors when the session changed before they surface', async () => {
        const setMessages = vi.fn();
        let activeSid = 'session-a';
        const fetchMessages = vi.fn().mockImplementation(() => new Promise((_: any, reject: any) => {
            activeSid = 'session-b';
            reject(new Error('boom'));
        }));
        const reload = createReloadMessages({
            fetchMessages,
            getActiveSessionId: () => activeSid,
            setMessages,
        });
        const result = await reload();
        expect(setMessages).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });
});
