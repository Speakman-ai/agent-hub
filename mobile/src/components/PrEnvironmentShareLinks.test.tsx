/** @vitest-environment jsdom */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  Text: ({ children }: any) => <span>{children}</span>,
  TouchableOpacity: ({ children, disabled, onPress, accessibilityLabel }: any) => (
    <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  View: ({ children }: any) => <div>{children}</div>,
  TextInput: ({ accessibilityLabel, value, onChangeText }: any) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText((event.target as HTMLInputElement).value)}
    />
  ),
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
vi.mock('../utils/api', () => ({
  api: {
    listPrEnvironmentShareLinks: vi.fn(),
    createPrEnvironmentShareLink: vi.fn(),
    revokePrEnvironmentShareLink: vi.fn(),
    setPrEnvironmentSharePassword: vi.fn(),
  },
}));

import { api } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';
import PrEnvironmentShareLinks from './PrEnvironmentShareLinks';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />));
  await settle();
  await settle();
  return host;
}

const click = async (el: Element | null) => {
  (el as HTMLButtonElement).click();
  await settle();
  await settle();
};

describe('mobile PrEnvironmentShareLinks', () => {
  it('renders nothing without wildcard ingress', async () => {
    mocked.listPrEnvironmentShareLinks.mockRejectedValue(
      Object.assign(new Error('no ingress'), {
        status: 400,
        code: 'pr_env_ingress_not_configured',
      }),
    );
    const el = await mount();
    expect(el.innerHTML).toBe('');
  });

  it('creates, copies, and revokes links', async () => {
    const url = 'https://pr-7--demo.preview.example.com/?share=ahs_x';
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [
        {
          id: 'l1',
          projectId: 'demo',
          prNumber: 7,
          label: 'QA',
          url,
          status: 'active',
          createdBy: 'u1',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000 * 3).toISOString(),
          revokedAt: null,
          canRevoke: true,
        },
      ],
      passwordRequired: false,
      canManage: true,
      canSetPassword: false,
    });
    mocked.createPrEnvironmentShareLink.mockResolvedValue({ link: { url } });
    mocked.revokePrEnvironmentShareLink.mockResolvedValue({});
    const el = await mount();
    expect(el.textContent).toContain('Share links (1 active)');
    await click(el.querySelector('[aria-label="Share links"]'));
    await click(el.querySelector('[aria-label="Expires in 1 day"]'));
    await click(el.querySelector('[aria-label="Create and copy share link"]'));
    expect(mocked.createPrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, {
      expiresInHours: 24,
      label: undefined,
    });
    expect(copyToClipboard).toHaveBeenCalledWith(url);
    await click(el.querySelector('[aria-label="Revoke share link"]'));
    expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, 'l1');
  });

  it('shows Revoke only on links the caller may revoke', async () => {
    const base = {
      projectId: 'demo',
      prNumber: 7,
      label: null,
      url: 'https://pr-7--demo.preview.example.com/?share=ahs_y',
      status: 'active',
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      revokedAt: null,
    };
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [
        { ...base, id: 'mine', canRevoke: true },
        { ...base, id: 'theirs', canRevoke: false },
      ],
      passwordRequired: false,
      canManage: false,
      canSetPassword: false,
    });
    mocked.revokePrEnvironmentShareLink.mockReset().mockResolvedValue({});
    const el = await mount();
    await click(el.querySelector('[aria-label="Share links"]'));
    expect(el.querySelector('[aria-label="Create and copy share link"]')).toBeNull();
    const revokes = el.querySelectorAll('[aria-label="Revoke share link"]');
    expect(revokes).toHaveLength(1);
    await click(revokes[0]);
    expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, 'mine');
  });

  it('shows a transient failure with Retry and recovers', async () => {
    mocked.listPrEnvironmentShareLinks
      .mockReset()
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 502'), { status: 502 }))
      .mockResolvedValue({
        links: [],
        passwordRequired: false,
        canManage: false,
        canSetPassword: false,
      });
    const el = await mount();
    expect(el.textContent).toContain('Share links did not load: HTTP 502');
    await click(el.querySelector('[aria-label="Retry share links"]'));
    expect(el.textContent).toContain('Share links');
    expect(el.textContent).not.toContain('did not load');
  });

  it('retries on its own after a failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listPrEnvironmentShareLinks
        .mockReset()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValue({
          links: [],
          passwordRequired: false,
          canManage: false,
          canSetPassword: false,
        });
      const el = await mount();
      expect(el.textContent).toContain('did not load');
      await vi.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(2);
      expect(el.textContent).not.toContain('did not load');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mutation that finishes after a PR switch does not touch the new PR', async () => {
    let finishRevoke: (v: unknown) => void = () => {};
    mocked.revokePrEnvironmentShareLink
      .mockReset()
      .mockImplementation(() => new Promise((resolve) => (finishRevoke = resolve)));
    const linkFor = (n: number) => ({
      id: n === 7 ? 'a-link' : 'b-link',
      projectId: 'demo',
      prNumber: n,
      label: n === 7 ? 'From A' : 'From B',
      url: `https://pr-${n}--demo.preview.example.com/?share=ahs_x`,
      status: 'active',
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      revokedAt: null,
      canRevoke: true,
    });
    mocked.listPrEnvironmentShareLinks
      .mockReset()
      .mockImplementation(async (_p: string, n: number) => ({
        links: [linkFor(n)],
        passwordRequired: false,
        canManage: true,
        canSetPassword: false,
      }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const show = async (n: number) => {
      flushSync(() => root!.render(<PrEnvironmentShareLinks projectId="demo" prNumber={n} />));
      await settle();
      await settle();
    };
    await show(7);
    await click(host.querySelector('[aria-label="Share links"]'));
    expect(host.textContent).toContain('From A');
    await click(host.querySelector('[aria-label="Revoke share link"]'));
    expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, 'a-link');

    await show(8);
    expect(host.textContent).toContain('From B');
    const bRevoke = host.querySelector('[aria-label="Revoke share link"]') as HTMLButtonElement;
    expect(bRevoke.disabled).toBe(false);

    mocked.listPrEnvironmentShareLinks.mockClear();
    finishRevoke({});
    await settle();
    await settle();
    expect(mocked.listPrEnvironmentShareLinks).not.toHaveBeenCalled();
    expect(host.textContent).toContain('From B');
    expect(host.textContent).not.toContain('From A');
  });

  it('a retry slower than the retry interval is not overlapped or discarded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listOf = (label: string) => ({
        links: [
          {
            id: 'l1',
            projectId: 'demo',
            prNumber: 7,
            label,
            url: 'https://pr-7--demo.preview.example.com/?share=ahs_x',
            status: 'active',
            createdBy: 'u1',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            revokedAt: null,
            canRevoke: true,
          },
        ],
        passwordRequired: false,
        canManage: true,
        canSetPassword: false,
      });
      let finishRetry: (v: unknown) => void = () => {};
      mocked.listPrEnvironmentShareLinks
        .mockReset()
        .mockResolvedValueOnce(listOf('Old list'))
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { status: 503 }))
        .mockImplementationOnce(() => new Promise((resolve) => (finishRetry = resolve)));
      mocked.revokePrEnvironmentShareLink.mockReset().mockResolvedValue({});
      const el = await mount();
      await click(el.querySelector('[aria-label="Share links"]'));
      expect(el.textContent).toContain('Old list');
      await click(el.querySelector('[aria-label="Revoke share link"]'));
      expect(el.textContent).toContain('Could not refresh: HTTP 503');
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
      const retry = el.querySelector('[aria-label="Retry share links"]') as HTMLButtonElement;
      expect(retry.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
      expect(el.textContent).toContain('Old list');

      finishRetry(listOf('Fresh list'));
      await settle();
      await settle();
      expect(el.textContent).toContain('Fresh list');
      expect(el.textContent).not.toContain('Could not refresh');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with showWhenEmpty off, renders only when links exist', async () => {
    const listWith = (n: number) => ({
      links: Array.from({ length: n }, (_, i) => ({
        id: `l${i}`,
        projectId: 'demo',
        prNumber: 7,
        label: `Link ${i}`,
        url: null,
        status: 'revoked',
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        revokedAt: new Date().toISOString(),
        canRevoke: false,
      })),
      passwordRequired: false,
      canManage: true,
      canSetPassword: false,
    });
    const render = async (n: number) => {
      mocked.listPrEnvironmentShareLinks.mockReset().mockResolvedValue(listWith(n));
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      flushSync(() =>
        root!.render(
          <PrEnvironmentShareLinks projectId="demo" prNumber={7} showWhenEmpty={false} />,
        ),
      );
      await settle();
      await settle();
      return host;
    };
    expect((await render(0)).innerHTML).toBe('');
    root!.unmount();
    host!.remove();
    expect((await render(1)).textContent).toContain('Share links');
  });
});
