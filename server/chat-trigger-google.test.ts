import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from './db.js';
import * as chat from './hub-chat-store.js';
import { createTrigger } from './chat-triggers-store.js';
import { routeBroadcastToChatTriggers, type TriggerLookups } from './chat-trigger-router.js';
import {
  buildGoogleChatTriggerText,
  sendTriggerToGoogleChat,
  type GoogleChatTriggerSend,
} from './chat-trigger-google.js';
import type { ChatTriggerCard } from '../shared/utils/chatTriggers.js';

const ALICE = 'user-alice';
const PROJECT = 'acme-web';

const lookups: TriggerLookups = {
  resolveProjectId: () => PROJECT,
  getSession: () => ({ name: 'Fix login', agentId: 'dev', ownerUserId: ALICE }),
  getCard: () => ({
    title: 'Ship triggers',
    label: 'WEB-7',
    epicId: null,
    labels: [],
    column: 'Review',
  }),
  getPrTitle: () => 'Add chat triggers',
  getFinalizeRun: () => ({ projectId: PROJECT, sessionId: 'sess-alice' }),
};

const CARD_MOVED = {
  type: 'card_moved',
  projectId: PROJECT,
  cardId: 'card-1',
  columnName: 'Review',
  moveId: 'move-1',
};

let channel: ReturnType<typeof chat.createChannel>;

beforeEach(() => {
  getDb().exec('DELETE FROM project_chat_trigger_posts; DELETE FROM project_chat_triggers;');
  channel = chat.createChannel({
    orgId: `org-${randomUUID()}`,
    kind: 'trigger',
    name: 'acme-activity',
    projectId: PROJECT,
    createdByUserId: ALICE,
  });
});

function trigger(googleChatSpaceId: string | null = 'AAAA') {
  return createTrigger({
    projectId: PROJECT,
    event: 'card_moved',
    channelId: channel.id,
    googleChatSpaceId,
    createdBy: ALICE,
  });
}

function okResponse() {
  return new Response(JSON.stringify({ name: 'spaces/AAAA/messages/m1' }), { status: 200 });
}

/** The real sender with a mocked fetch and a connected creator. */
function senderWith(fetchImpl: typeof fetch) {
  return (send: GoogleChatTriggerSend) =>
    sendTriggerToGoogleChat(send, {
      fetchImpl,
      canSend: () => true,
      resolveToken: async () => 'tok-alice',
      publicUrl: 'https://hub.test/',
    });
}

function route(sendToGoogleChat: (s: GoogleChatTriggerSend) => Promise<void>, log = vi.fn()) {
  return routeBroadcastToChatTriggers(CARD_MOVED, {
    lookups,
    broadcast: vi.fn(),
    creatorCanViewProject: () => true,
    sendToGoogleChat,
    log,
  });
}

/** Lets the fire-and-forget send settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('trigger Google Chat destination', () => {
  it('posts to both Agent Hub and the Google Chat space, as the creator', async () => {
    const t = trigger('AAAA');
    const fetchMock = vi.fn(async () => okResponse());
    const posted = route(senderWith(fetchMock as unknown as typeof fetch));
    await flush();

    expect(posted).toHaveLength(1);
    expect(chat.listMessages(channel.id)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://chat.googleapis.com/v1/spaces/AAAA/messages?requestId=agent-hub-trigger-${posted[0]!.id}`,
    );
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-alice');
    const text = JSON.parse(String(init.body)).text as string;
    expect(text).toContain('*');
    expect(text).toContain('<https://hub.test/projects/acme-web/board?card=card-1|');
    expect(t.google_chat_space_id).toBe('AAAA');

    // A duplicate broadcast posts nowhere.
    expect(route(senderWith(fetchMock as unknown as typeof fetch))).toHaveLength(0);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call Google for a trigger without a space', async () => {
    trigger(null);
    const send = vi.fn(async () => {});
    expect(route(send)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['Google returns an error', async () => new Response('{}', { status: 500 })],
    [
      'fetch rejects',
      async () => {
        throw new Error('network down');
      },
    ],
  ])('keeps the Agent Hub message when %s', async (_label, impl) => {
    trigger('AAAA');
    const log = vi.fn();
    const posted = route(senderWith(vi.fn(impl) as unknown as typeof fetch), log);
    await flush();
    expect(posted).toHaveLength(1);
    expect(chat.listMessages(channel.id)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Google Chat post failed/));
  });

  it('keeps the Agent Hub message when the sender throws synchronously', () => {
    trigger('AAAA');
    const log = vi.fn();
    const posted = route(() => {
      throw new Error('boom');
    }, log);
    expect(posted).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Google Chat post failed: boom/));
  });

  it('does not wait for a hanging Google call', () => {
    trigger('AAAA');
    const posted = route(() => new Promise<void>(() => {}));
    expect(posted).toHaveLength(1);
  });

  it('refuses to send when the creator has no Google Chat send access', async () => {
    const fetchMock = vi.fn();
    const card: ChatTriggerCard = {
      type: 'trigger',
      event: 'pr_merged',
      triggerId: 't',
      projectId: PROJECT,
      title: 'PR merged',
      status: 'success',
      statusLabel: 'Merged',
      detail: null,
      refs: [],
    };
    await expect(
      sendTriggerToGoogleChat(
        { userId: ALICE, spaceId: 'AAAA', card, messageId: 'm' },
        { fetchImpl: fetchMock as unknown as typeof fetch, canSend: () => false },
      ),
    ).rejects.toThrow(/Google Chat send access/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildGoogleChatTriggerText', () => {
  const card: ChatTriggerCard = {
    type: 'trigger',
    event: 'session_completed',
    triggerId: 't',
    projectId: PROJECT,
    title: 'Session <done>',
    status: 'success',
    statusLabel: 'Completed',
    detail: 'All done',
    refs: [
      { kind: 'session', targetId: 'sess-1', label: 'Fix login' },
      { kind: 'pr', targetId: '12', label: 'PR #12' },
    ],
  };

  it('links refs when the Hub has a public URL', () => {
    expect(buildGoogleChatTriggerText(card, 'https://hub.test')).toBe(
      [
        '*Session ‹done›* (Completed)',
        'All done',
        '• <https://hub.test/sessions/sess-1|Fix login>',
        '• PR #12',
        '_acme-web · Agent Hub_',
      ].join('\n'),
    );
  });

  it('falls back to plain labels without one', () => {
    expect(buildGoogleChatTriggerText(card, null)).toContain('• Fix login');
  });
});
