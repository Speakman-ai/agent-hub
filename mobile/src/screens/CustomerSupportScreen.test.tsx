// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getVotingItems: vi.fn(),
  castVote: vi.fn(),
  getSupportTicketComments: vi.fn(),
  addSupportTicketComment: vi.fn(),
  hideSupportTicketComment: vi.fn(),
  getProjectBoard: vi.fn(),
  getSupportTickets: vi.fn(),
  getProjects: vi.fn(),
  getAgents: vi.fn(),
  startVotingScaffolder: vi.fn(),
}));

// AsyncStorage-backed voter key: resolve immediately with no stored token so
// getVoterKey mints one.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}));

// Render RN primitives as DOM hosts mapping testID/onPress/accessibilityState.
function host(tag: string) {
  return ({ children, testID, onPress, accessibilityState, disabled, style }: any) =>
    React.createElement(
      tag,
      {
        'data-testid': testID,
        'data-selected': accessibilityState?.selected ? 'true' : undefined,
        disabled: disabled || undefined,
        onClick: onPress,
        style: Array.isArray(style) ? undefined : style,
      },
      children,
    );
}

function TextInputMock({ testID, value, onChangeText, placeholder }: any) {
  return React.createElement('input', {
    'data-testid': testID,
    value: value ?? '',
    placeholder,
    onChange: (e: any) => onChangeText?.(e.target.value),
  });
}

function SwitchMock({ testID, value, onValueChange }: any) {
  return React.createElement('input', {
    type: 'checkbox',
    'data-testid': testID,
    checked: !!value,
    onChange: (e: any) => onValueChange?.(e.target.checked),
  });
}

function FlatListMock({ data, renderItem, keyExtractor }: any) {
  return React.createElement(
    'div',
    { 'data-testid': 'flatlist' },
    (data || []).map((item: any, index: number) =>
      React.createElement(
        React.Fragment,
        { key: keyExtractor ? keyExtractor(item, index) : index },
        renderItem({ item, index }),
      ),
    ),
  );
}

vi.mock('react-native', () => ({
  View: host('div'),
  Text: host('span'),
  TouchableOpacity: host('button'),
  ScrollView: host('div'),
  Image: host('img'),
  ActivityIndicator: host('span'),
  Modal: ({ visible, children }: any) =>
    visible ? React.createElement('div', null, children) : null,
  TextInput: TextInputMock,
  Switch: SwitchMock,
  FlatList: FlatListMock,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  StyleSheet: { create: (styles: any) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: host('main') }));
vi.mock('../utils/api', () => ({ api: apiMocks }));
vi.mock('../utils/time', () => ({ relativeTime: () => 'just now' }));
vi.mock('@shared/utils/convertedCardLabel', () => ({
  convertedCardLabel: () => null,
  convertedCardId: () => null,
}));
vi.mock('../utils/supportTickets', () => ({
  sortTickets: (l: any[]) => l,
  resolveReplayUrl: () => null,
  resolveUploadUrl: () => null,
  performTicketDelete: vi.fn(),
  performTicketLink: vi.fn(),
  releaseStateLabel: () => '',
  mergeTicketDetail: (_cur: any, next: any) => next,
}));
vi.mock('../context/SidebarContext', () => ({
  SidebarContext: React.createContext({ openSidebar: () => {} }),
}));

// AppContext is stubbed per-test via this mutable holder so a test can push a
// live WS event through `lastSupportTicketEvent`.
const appState: any = {
  lastSupportTicketEvent: null,
  projects: [{ id: 'proj-1', name: 'Hub' }],
  agents: [],
  refreshSupportUnreadCount: vi.fn(),
  setSupportUnreadCount: vi.fn(),
  setActiveAgentId: vi.fn(),
  setActiveSessionId: vi.fn(),
};
vi.mock('../context/AppContext', () => ({
  useApp: () => appState,
}));

import { Alert } from 'react-native';
import CustomerSupportScreen, { VotingTab, CommentThread } from './CustomerSupportScreen';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 8; j += 1) await Promise.resolve();
    flushSync(() => undefined);
  }
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function typeInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function votingItem(overrides: any = {}) {
  return {
    id: 'f1',
    type: 'feature_request',
    subject: 'Dark mode',
    body: 'Please add dark mode',
    severity: 'low',
    status: 'new',
    created_at: '2026-01-01 00:00:00',
    voting: { score: 0, upvotes: 0, downvotes: 0, myVote: null, comment_count: 0 },
    ...overrides,
  };
}

describe('CustomerSupportScreen — VotingTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    appState.lastSupportTicketEvent = null;
    apiMocks.getVotingItems.mockResolvedValue([]);
    apiMocks.castVote.mockResolvedValue({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 });
    apiMocks.getSupportTickets.mockResolvedValue([]);
    apiMocks.getProjects.mockResolvedValue([]);
    apiMocks.getAgents.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the voting list sorted by score (highest first)', async () => {
    apiMocks.getVotingItems.mockResolvedValue([
      votingItem({
        id: 'low',
        subject: 'Low',
        voting: { score: 1, upvotes: 1, downvotes: 0, myVote: null },
      }),
      votingItem({
        id: 'high',
        subject: 'High',
        voting: { score: 9, upvotes: 9, downvotes: 0, myVote: null },
      }),
    ]);
    const { container, root } = mount();
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();

    const items = Array.from(container.querySelectorAll('[data-testid="voting-item"]'));
    expect(items.length).toBe(2);
    // Highest score first: the 'high' score element precedes the 'low' one.
    const scores = Array.from(container.querySelectorAll('[data-testid^="vote-score-"]')).map((n) =>
      n.getAttribute('data-testid'),
    );
    expect(scores).toEqual(['vote-score-high', 'vote-score-low']);

    flushSync(() => root.unmount());
  });

  it('passes the per-device voter token to the voting fetch', async () => {
    const { root } = mount();
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();
    const [, voterKey] = apiMocks.getVotingItems.mock.calls.at(-1)!;
    expect(typeof voterKey).toBe('string');
    expect(voterKey.length).toBeGreaterThan(0);
    flushSync(() => root.unmount());
  });

  it('sends value=1 on an upvote, then null when the same arrow is pressed again', async () => {
    apiMocks.getVotingItems.mockResolvedValue([
      votingItem({ id: 'f1', voting: { score: 2, upvotes: 2, downvotes: 0, myVote: null } }),
    ]);
    apiMocks.castVote
      .mockResolvedValueOnce({ score: 3, upvotes: 3, downvotes: 0, myVote: 1 })
      .mockResolvedValueOnce({ score: 2, upvotes: 2, downvotes: 0, myVote: null });
    const { container, root } = mount();
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();

    click(container.querySelector('[data-testid="vote-up-f1"]'));
    await flush();
    expect(apiMocks.castVote.mock.calls[0][3]).toBe(1);
    expect(
      container.querySelector('[data-testid="vote-up-f1"]')?.getAttribute('data-selected'),
    ).toBe('true');

    click(container.querySelector('[data-testid="vote-up-f1"]'));
    await flush();
    expect(apiMocks.castVote.mock.calls[1][3]).toBeNull();
    expect(
      container.querySelector('[data-testid="vote-up-f1"]')?.getAttribute('data-selected'),
    ).toBeNull();

    flushSync(() => root.unmount());
  });

  it('retries the newer queued vote when a press lands before the first request rejects', async () => {
    // Regression: a second press while castVote is in flight must not be lost if
    // the first request then fails — the newer desired value has to be sent.
    apiMocks.getVotingItems.mockResolvedValue([
      votingItem({ id: 'f1', voting: { score: 2, upvotes: 2, downvotes: 0, myVote: null } }),
    ]);
    const first = deferred<any>();
    apiMocks.castVote
      .mockReturnValueOnce(first.promise) // upvote — held open, then rejected
      .mockResolvedValueOnce({ score: 2, upvotes: 2, downvotes: 0, myVote: null }); // retract
    const { container, root } = mount();
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();

    // Press 1 (upvote → value 1). The request is now in flight (unresolved).
    click(container.querySelector('[data-testid="vote-up-f1"]'));
    await flush();
    expect(apiMocks.castVote).toHaveBeenCalledTimes(1);
    expect(apiMocks.castVote.mock.calls[0][3]).toBe(1);

    // Press 2 before the first settles (upvote again on a now-upvoted tally →
    // retract → value null). This updates `desired` while the worker is parked.
    click(container.querySelector('[data-testid="vote-up-f1"]'));
    await flush();

    // The first request rejects. The worker must retry with the newer desired
    // (null), not revert-and-exit dropping the second press.
    first.reject(new Error('boom'));
    await flush();

    expect(apiMocks.castVote).toHaveBeenCalledTimes(2);
    expect(apiMocks.castVote.mock.calls[1][3]).toBeNull();
    // Final UI reflects the retracted (newer) vote, and no failure alert fired
    // because the superseding request succeeded.
    expect(
      container.querySelector('[data-testid="vote-up-f1"]')?.getAttribute('data-selected'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="vote-score-f1"]')?.textContent).toBe('2');
    expect(Alert.alert).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });

  it('reconciles a peer vote from the support_ticket_vote_updated event', async () => {
    apiMocks.getVotingItems.mockResolvedValue([
      votingItem({ id: 'f1', voting: { score: 2, upvotes: 2, downvotes: 0, myVote: null } }),
    ]);
    const { container, root } = mount();
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();
    expect(container.querySelector('[data-testid="vote-score-f1"]')?.textContent).toBe('2');

    appState.lastSupportTicketEvent = {
      type: 'support_ticket_vote_updated',
      projectId: 'p1',
      ticketId: 'f1',
      score: 5,
      upvotes: 5,
      downvotes: 0,
      bump: 1,
    };
    flushSync(() => root.render(<VotingTab projectId="p1" onOpen={vi.fn()} />));
    await flush();
    expect(container.querySelector('[data-testid="vote-score-f1"]')?.textContent).toBe('5');

    flushSync(() => root.unmount());
  });
});

describe('CustomerSupportScreen — CommentThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.lastSupportTicketEvent = null;
    apiMocks.getSupportTicketComments.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds a comment and renders it (roundtrip)', async () => {
    apiMocks.addSupportTicketComment.mockResolvedValue({
      id: 'c1',
      body: 'Great idea',
      display_name: 'Sam',
      created_at: '2026-01-01 00:00:00',
    });
    const { container, root } = mount();
    flushSync(() => root.render(<CommentThread projectId="p1" ticketId="f1" />));
    await flush();

    typeInput(
      container.querySelector('[data-testid="comment-display-name"]') as HTMLInputElement,
      'Sam',
    );
    typeInput(
      container.querySelector('[data-testid="comment-body"]') as HTMLInputElement,
      'Great idea',
    );
    await flush();

    click(container.querySelector('[data-testid="comment-submit"]'));
    await flush();

    expect(apiMocks.addSupportTicketComment).toHaveBeenCalledWith('p1', 'f1', {
      body: 'Great idea',
      displayName: 'Sam',
    });
    expect(container.querySelector('[data-testid="comment-row-c1"]')).toBeTruthy();
    expect(container.textContent).toContain('Great idea');

    flushSync(() => root.unmount());
  });

  it('drops a comment when a support_ticket_comment_deleted event arrives', async () => {
    apiMocks.getSupportTicketComments.mockResolvedValue([
      { id: 'c1', body: 'Old', display_name: null, created_at: '2026-01-01 00:00:00' },
    ]);
    const { container, root } = mount();
    flushSync(() => root.render(<CommentThread projectId="p1" ticketId="f1" />));
    await flush();
    expect(container.querySelector('[data-testid="comment-row-c1"]')).toBeTruthy();

    appState.lastSupportTicketEvent = {
      type: 'support_ticket_comment_deleted',
      projectId: 'p1',
      ticketId: 'f1',
      commentId: 'c1',
      bump: 1,
    };
    flushSync(() => root.render(<CommentThread projectId="p1" ticketId="f1" />));
    await flush();
    expect(container.querySelector('[data-testid="comment-row-c1"]')).toBeFalsy();

    flushSync(() => root.unmount());
  });
});

const SCAFFOLD_PROJECTS = [
  { id: 'proj-1', name: 'Hub' },
  { id: 'acme-app', name: 'Acme' },
];
const SCAFFOLD_AGENTS = [
  { id: 'agent-hub', name: 'Hub Dev', projectId: 'proj-1', engine: 'claude-code' },
  {
    id: 'agent-reviewer',
    name: 'Reviewer',
    projectId: 'proj-1',
    engine: 'claude-code',
    role: 'reviewer',
  },
  { id: 'agent-acme', name: 'Acme Dev', projectId: 'acme-app', engine: 'cursor-agent' },
];

describe('CustomerSupportScreen — Set up voting in an app launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    appState.lastSupportTicketEvent = null;
    appState.projects = SCAFFOLD_PROJECTS;
    appState.agents = SCAFFOLD_AGENTS;
    apiMocks.getSupportTickets.mockResolvedValue([]);
    apiMocks.getVotingItems.mockResolvedValue([]);
    apiMocks.getProjects.mockResolvedValue(SCAFFOLD_PROJECTS);
    apiMocks.getAgents.mockResolvedValue(SCAFFOLD_AGENTS);
    apiMocks.startVotingScaffolder.mockResolvedValue({
      sessionId: 'sess-vote-1',
      agentId: 'agent-acme',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function openLauncher(nav: { navigate: ReturnType<typeof vi.fn> } = { navigate: vi.fn() }) {
    const { container, root } = mount();
    flushSync(() =>
      root.render(
        <CustomerSupportScreen route={{ params: { projectId: 'proj-1' } }} navigation={nav} />,
      ),
    );
    await flush();
    click(container.querySelector('[data-testid="support-tab-voting"]'));
    await flush();
    click(container.querySelector('[data-testid="voting-setup-launcher"]'));
    await flush();
    return { container, root, nav };
  }

  it('renders the launcher on the Voting tab and hides it on Issues', async () => {
    const { container, root } = mount();
    flushSync(() =>
      root.render(
        <CustomerSupportScreen
          route={{ params: { projectId: 'proj-1' } }}
          navigation={{ navigate: vi.fn() }}
        />,
      ),
    );
    await flush();
    expect(container.querySelector('[data-testid="voting-setup-launcher"]')).toBeNull();

    click(container.querySelector('[data-testid="support-tab-voting"]'));
    await flush();
    const launcher = container.querySelector('[data-testid="voting-setup-launcher"]');
    expect(launcher?.textContent).toContain('Set up voting in an app');

    flushSync(() => root.unmount());
  });

  it('opens a modal with the styling explainer, defaults the project, and omits reviewers', async () => {
    const { container, root } = await openLauncher();
    expect(container.querySelector('[data-testid="voting-setup-modal"]')).toBeTruthy();
    const explainer = container.querySelector(
      '[data-testid="voting-setup-explainer"]',
    )?.textContent;
    expect(explainer).toMatch(/match its existing styling/i);
    expect(explainer).toMatch(/where the voting page should live/i);

    expect(
      container
        .querySelector('[data-testid="voting-setup-project-option-proj-1"]')
        ?.getAttribute('data-selected'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="voting-setup-agent-option-agent-hub"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="voting-setup-agent-option-agent-reviewer"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Reviewer');

    flushSync(() => root.unmount());
  });

  it('selecting a project+agent and confirming seeds a session and navigates to it', async () => {
    const { container, root, nav } = await openLauncher();

    click(container.querySelector('[data-testid="voting-setup-project-option-acme-app"]'));
    await flush();
    expect(
      container
        .querySelector('[data-testid="voting-setup-agent-option-agent-acme"]')
        ?.getAttribute('data-selected'),
    ).toBe('true');

    typeInput(
      container.querySelector('[data-testid="voting-setup-page-hint"]') as HTMLInputElement,
      'Ideas',
    );
    click(container.querySelector('[data-testid="voting-setup-confirm"]'));
    await flush();

    expect(apiMocks.startVotingScaffolder).toHaveBeenCalledWith('acme-app', {
      agentId: 'agent-acme',
      pageNameHint: 'Ideas',
    });
    expect(appState.setActiveAgentId).toHaveBeenCalledWith('agent-acme');
    expect(appState.setActiveSessionId).toHaveBeenCalledWith('sess-vote-1');
    expect(nav.navigate).toHaveBeenCalledWith('Chat');
    expect(container.querySelector('[data-testid="voting-setup-modal"]')).toBeNull();

    flushSync(() => root.unmount());
  });

  it('surfaces an error and stays on the modal when spawn fails', async () => {
    apiMocks.startVotingScaffolder.mockRejectedValueOnce(new Error('no agents'));
    const { container, root, nav } = await openLauncher();

    click(container.querySelector('[data-testid="voting-setup-confirm"]'));
    await flush();

    expect(container.querySelector('[data-testid="voting-setup-error"]')?.textContent).toContain(
      'no agents',
    );
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(appState.setActiveSessionId).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="voting-setup-modal"]')).toBeTruthy();

    flushSync(() => root.unmount());
  });

  it('disables cancel and close while setup is in flight', async () => {
    const pending = deferred<any>();
    apiMocks.startVotingScaffolder.mockReturnValueOnce(pending.promise);
    const { container, root } = await openLauncher();

    click(container.querySelector('[data-testid="voting-setup-confirm"]'));
    await flush();

    const cancel = container.querySelector(
      '[data-testid="voting-setup-cancel"]',
    ) as HTMLButtonElement;
    const close = container.querySelector(
      '[data-testid="voting-setup-close"]',
    ) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(close.disabled).toBe(true);

    click(cancel);
    click(close);
    await flush();
    expect(container.querySelector('[data-testid="voting-setup-modal"]')).toBeTruthy();
    expect(appState.setActiveSessionId).not.toHaveBeenCalled();

    pending.resolve({ sessionId: 'sess-vote-1', agentId: 'agent-hub' });
    await flush();
    flushSync(() => root.unmount());
  });

  it('does not navigate if the modal unmounts while setup is in flight', async () => {
    const pending = deferred<any>();
    apiMocks.startVotingScaffolder.mockReturnValueOnce(pending.promise);
    const { container, root, nav } = await openLauncher();

    click(container.querySelector('[data-testid="voting-setup-confirm"]'));
    await flush();
    expect(apiMocks.startVotingScaffolder).toHaveBeenCalled();

    flushSync(() => root.unmount());
    pending.resolve({ sessionId: 'sess-vote-1', agentId: 'agent-hub' });
    await flush();

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(appState.setActiveSessionId).not.toHaveBeenCalled();
    expect(appState.setActiveAgentId).not.toHaveBeenCalled();
  });
});
