// @vitest-environment jsdom
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function host(tag: string) {
  return ({ children, onPress, disabled, accessibilityLabel, accessibilityRole, testID }: any) =>
    React.createElement(
      tag,
      {
        onClick: onPress,
        disabled,
        'aria-label': accessibilityLabel,
        role: accessibilityRole,
        'data-testid': testID,
      },
      children,
    );
}
vi.mock('react-native', () => ({
  View: host('div'),
  Text: host('span'),
  TouchableOpacity: host('button'),
  StyleSheet: { create: (styles: any) => styles },
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/api', () => ({ api: { getDesktopRuntime: vi.fn() } }));

import OrganizationComputerBar from './OrganizationComputerBar';

const scope = (tools: string[], extra: Record<string, unknown> = {}) => ({
  enabled: true,
  archivedAt: null,
  projects: 'all-linked' as const,
  tools,
  ...extra,
});
const assistant = {
  name: 'Organization Assistant',
  computerToolEnabled: true,
  organizationScope: scope(['computer']),
};
const custom = {
  name: 'Finance',
  computerToolEnabled: false,
  organizationScope: scope(['computer']),
};

function Harness({ agent, put, runtime }: any) {
  const [value, setValue] = useState<0 | 1 | null>(null);
  return (
    <OrganizationComputerBar
      agent={agent}
      organizationName="Acme"
      user={{ email: 'ana@example.com' }}
      sessionValue={value}
      loadRuntime={runtime ?? (() => Promise.resolve({ available: true }))}
      onChange={async (enabled) => setValue(await put(enabled))}
      onOpenViewer={() => {}}
    />
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function flush() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
async function render(node: React.ReactElement) {
  flushSync(() => root.render(node));
  await flush();
}
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
async function click(label: string) {
  expect(button(label), label).toBeTruthy();
  button(label)!.click();
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('OrganizationComputerBar (mobile)', () => {
  it('inherits the Assistant default, overrides it, and resets to the default', async () => {
    const put = vi.fn(async (enabled: boolean | null) =>
      enabled === null ? null : enabled ? 1 : 0,
    );
    await render(<Harness agent={assistant} put={put} />);
    expect(text('organization-computer-owner')).toBe(
      'Organization Assistant in Acme · private to ana@example.com',
    );
    expect(text('organization-computer-state')).toBe('On');
    expect(text('organization-computer-source')).toBe('Agent default');
    await click('Turn off for this chat');
    expect(text('organization-computer-state')).toBe('Off');
    expect(text('organization-computer-source')).toBe('This chat');
    await click('Use agent default (On)');
    expect(put).toHaveBeenLastCalledWith(null);
    expect(text('organization-computer-state')).toBe('On');
  });

  it('keeps a custom agent off until enabled, and reports a denial inline', async () => {
    const put = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { status: 403 });
    });
    await render(<Harness agent={custom} put={put} />);
    expect(text('organization-computer-state')).toBe('Off');
    expect(button('Open Computer')).toBeUndefined();
    await click('Turn on for this chat');
    expect(put).toHaveBeenCalledWith(true);
    expect(text('organization-computer-error')).toMatch(/isn't allowed for this agent/);
    expect(text('organization-computer-state')).toBe('Off');
  });

  it('shows an unavailable backend as recoverable and archived agents as blocked', async () => {
    await render(
      <Harness
        agent={assistant}
        put={vi.fn()}
        runtime={() => Promise.resolve({ available: false, reason: 'No backend.' })}
      />,
    );
    expect(text('organization-computer-state')).toBe('Unavailable');
    expect(text('organization-computer-detail')).toMatch(/No backend\..*Chat still works/);
    expect(button('Open Computer')).toBeTruthy();

    await render(
      <Harness
        agent={{ ...assistant, organizationScope: scope(['computer'], { archivedAt: 'now' }) }}
        put={vi.fn()}
      />,
    );
    expect(text('organization-computer-state')).toBe('Agent archived');
    expect(button('Turn off for this chat')).toBeUndefined();
  });
});
