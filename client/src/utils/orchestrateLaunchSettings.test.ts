import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelOrchestrateAutoStart,
  isOrchestrateAutoStartCancelled,
  markOrchestrateAutoStartFired,
  resetOrchestrateLaunchStateForTests,
  subscribeOrchestrateAutoStart,
} from './orchestrateLaunchSettings';

beforeEach(() => {
  localStorage.clear();
  resetOrchestrateLaunchStateForTests();
});

describe('orchestrate auto start claims', () => {
  it('refuses to fire a cancelled card and notifies subscribers of the cancel', () => {
    const listener = vi.fn();
    const stop = subscribeOrchestrateAutoStart(listener);
    cancelOrchestrateAutoStart('card-1');
    expect(listener).toHaveBeenCalled();
    expect(markOrchestrateAutoStartFired('card-1')).toBe(false);
    expect(markOrchestrateAutoStartFired('card-2')).toBe(true);
    expect(markOrchestrateAutoStartFired('card-2')).toBe(false);
    stop();
  });

  it('keeps a cancel after the store is reloaded', () => {
    cancelOrchestrateAutoStart('card-1');
    // A page reload: memory is gone, localStorage is not.
    resetOrchestrateLaunchStateForTests();
    expect(isOrchestrateAutoStartCancelled('card-1')).toBe(true);
    expect(markOrchestrateAutoStartFired('card-1')).toBe(false);
    expect(isOrchestrateAutoStartCancelled('card-2')).toBe(false);
  });

  it('stops a countdown in another tab once both tabs have loaded', async () => {
    // Two tabs: two independent copies of the store over one localStorage.
    vi.resetModules();
    const tabA = await import('./orchestrateLaunchSettings');
    vi.resetModules();
    const tabB = await import('./orchestrateLaunchSettings');
    expect(tabA).not.toBe(tabB);
    expect(tabA.isOrchestrateAutoStartCancelled('card-x')).toBe(false);
    expect(tabB.isOrchestrateAutoStartCancelled('card-x')).toBe(false);

    const listener = vi.fn();
    const stop = tabB.subscribeOrchestrateAutoStart(listener);
    tabA.cancelOrchestrateAutoStart('card-x');
    // The browser fires this in tab B when tab A writes the key.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agenthub:orchestrate-autostart-cancelled' }),
    );
    expect(listener).toHaveBeenCalled();
    expect(tabB.isOrchestrateAutoStartCancelled('card-x')).toBe(true);
    expect(tabB.markOrchestrateAutoStartFired('card-x')).toBe(false);
    stop();
  });

  it('refuses a cancelled claim even when the storage event was missed', async () => {
    vi.resetModules();
    const tabA = await import('./orchestrateLaunchSettings');
    vi.resetModules();
    const tabB = await import('./orchestrateLaunchSettings');
    expect(tabB.isOrchestrateAutoStartCancelled('card-y')).toBe(false);
    tabA.cancelOrchestrateAutoStart('card-y');
    expect(tabB.markOrchestrateAutoStartFired('card-y')).toBe(false);
  });

  it("does not drop another tab's cancels when saving", async () => {
    vi.resetModules();
    const tabA = await import('./orchestrateLaunchSettings');
    vi.resetModules();
    const tabB = await import('./orchestrateLaunchSettings');
    tabA.isOrchestrateAutoStartCancelled('warm');
    tabB.isOrchestrateAutoStartCancelled('warm');
    tabA.cancelOrchestrateAutoStart('from-a');
    tabB.cancelOrchestrateAutoStart('from-b');
    const saved = JSON.parse(
      localStorage.getItem('agenthub:orchestrate-autostart-cancelled') ?? '[]',
    );
    expect(saved).toEqual(expect.arrayContaining(['from-a', 'from-b']));
  });

  it('carries an Auto start change to another tab', async () => {
    vi.resetModules();
    const tabA = await import('./orchestrateLaunchSettings');
    vi.resetModules();
    const tabB = await import('./orchestrateLaunchSettings');
    tabA.setOrchestrateLaunchSettings('chat-9', { autoStart: true });
    expect(tabB.getOrchestrateLaunchSettings('chat-9').autoStart).toBe(true);
    tabA.setOrchestrateLaunchSettings('chat-9', { autoStart: false });
    const listener = vi.fn();
    const stop = tabB.subscribeOrchestrateLaunchSettings('chat-9', listener);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agenthub:orchestrate-launch:chat-9' }),
    );
    expect(listener).toHaveBeenCalled();
    expect(tabB.getOrchestrateLaunchSettings('chat-9').autoStart).toBe(false);
    stop();
  });
});
