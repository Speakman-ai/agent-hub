import { describe, expect, it, vi } from 'vitest';
import { createOrgSwitcher } from './orgSwitch';

const never = () => new Promise<void>(() => {});

describe('createOrgSwitcher', () => {
  it('resolves once the connection switched, even while the data reload hangs', async () => {
    const switchOrg = vi.fn().mockResolvedValue(undefined);
    const onConnectionChanged = vi.fn();
    const loadData = vi.fn(never);
    const switchToOrg = createOrgSwitcher({ switchOrg, onConnectionChanged, loadData });

    // A hung reload must not block the caller: this would time out otherwise.
    await switchToOrg('b');

    expect(switchOrg).toHaveBeenCalledWith('b');
    expect(onConnectionChanged).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(loadData).toHaveBeenCalledTimes(1);
  });

  it('lets a newer switch proceed while an older reload is still pending', async () => {
    const isCurrentFlags: Array<() => boolean> = [];
    const loadData = vi.fn((isCurrent: () => boolean) => {
      isCurrentFlags.push(isCurrent);
      return never();
    });
    const switchToOrg = createOrgSwitcher({
      switchOrg: vi.fn(),
      onConnectionChanged: vi.fn(),
      loadData,
    });

    await switchToOrg('a');
    await switchToOrg('b');
    await Promise.resolve();

    expect(loadData).toHaveBeenCalledTimes(2);
    // The first reload's results would belong to the old server: discard them.
    expect(isCurrentFlags[0]()).toBe(false);
    expect(isCurrentFlags[1]()).toBe(true);
  });

  it('reports reload failures for the current switch without rejecting the caller', async () => {
    const onLoadError = vi.fn();
    const switchToOrg = createOrgSwitcher({
      switchOrg: vi.fn(),
      onConnectionChanged: vi.fn(),
      loadData: vi.fn().mockRejectedValue(new Error('boom')),
      onLoadError,
    });
    await expect(switchToOrg('a')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('propagates a failure to switch the connection itself', async () => {
    const onConnectionChanged = vi.fn();
    const switchToOrg = createOrgSwitcher({
      switchOrg: vi.fn().mockRejectedValue(new Error('storage full')),
      onConnectionChanged,
      loadData: vi.fn(),
    });
    await expect(switchToOrg('a')).rejects.toThrow('storage full');
    expect(onConnectionChanged).not.toHaveBeenCalled();
  });
});
