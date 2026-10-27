import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem, ListHeaderComponent }: any) => (
    <div>
      {ListHeaderComponent}
      {(data || []).map((item: any, index: number) => renderItem({ item, index }))}
    </div>
  ),
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('../components/AppIcon', () => ({ default: 'AppIcon' }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));

import {
  buildSendBody,
  ComposeModal,
  gmailReturnTo,
  GmailContent,
  loadInboxThreads,
  GMAIL_SURFACE_SCOPES,
  openGmailOAuth,
  parseRecipients,
} from './GmailScreen';

const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

describe('GmailScreen mobile parity', () => {
  it('renders a thread snippet with compose and refresh controls', () => {
    const html = renderToStaticMarkup(
      <GmailContent
        loading={false}
        threadsLoading={false}
        error={null}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
          serverConfigured: true,
        }}
        threads={[{ id: 't1', snippet: 'Quarterly review', historyId: '9' }]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCompose={() => undefined}
        onOpenThread={() => undefined}
      />,
    );

    expect(html).toContain('Mail');
    expect(html).toContain('Refresh');
    expect(html).toContain('Compose');
    expect(html).toContain('Quarterly review');
  });

  it('renders the Important section above the list and drops pinned threads from it', () => {
    const html = renderToStaticMarkup(
      <GmailContent
        loading={false}
        threadsLoading={false}
        error={null}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
          serverConfigured: true,
        }}
        threads={[
          { id: 't1', accountId: 'work', snippet: 'Quarterly review', historyId: '9' },
          { id: 't2', accountId: 'work', snippet: 'Weekly newsletter', historyId: '8' },
          // Same thread id in another mailbox: only work pinned t1, so this stays.
          { id: 't1', accountId: 'home', snippet: 'Home thread', historyId: '7' },
        ]}
        pinnedKeys={new Set(['work\u0000t1'])}
        importantSection={<span>IMPORTANT-SECTION</span>}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCompose={() => undefined}
        onOpenThread={() => undefined}
      />,
    );
    expect(html.indexOf('IMPORTANT-SECTION')).toBeLessThan(html.indexOf('Weekly newsletter'));
    expect(html).not.toContain('Quarterly review');
    expect(html).toContain('Home thread');
  });

  it('renders the not-linked route to connect Google', () => {
    const html = renderToStaticMarkup(
      <GmailContent
        loading={false}
        threadsLoading={false}
        error={null}
        status={{ connected: false, grantedScopes: [], serverConfigured: true }}
        threads={[]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCompose={() => undefined}
        onOpenThread={() => undefined}
      />,
    );

    expect(html).toContain('Connect Google to use Gmail');
    expect(html).toContain('Connect Google');
  });

  it('renders the inline Enable Gmail affordance when connected but missing consent', () => {
    const html = renderToStaticMarkup(
      <GmailContent
        loading={false}
        threadsLoading={false}
        error={null}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: ['https://www.googleapis.com/auth/calendar.events'],
          serverConfigured: true,
        }}
        threads={[]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCompose={() => undefined}
        onOpenThread={() => undefined}
      />,
    );

    expect(html).toContain('Enable Gmail access');
    expect(html).toContain('Enable Gmail');
  });

  it('parses recipients and builds a send body', () => {
    expect(parseRecipients('a@x.com, b@x.com; a@x.com')).toEqual(['a@x.com', 'b@x.com']);
    expect(buildSendBody({ to: 'a@x.com', cc: 'c@x.com', subject: ' Hi ', body: 'Body' })).toEqual({
      to: ['a@x.com'],
      cc: ['c@x.com'],
      subject: 'Hi',
      text: 'Body',
    });
  });

  it('starts OAuth with the GLOBAL gmail hash route and surface scopes', async () => {
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    };
    const openURL = vi.fn().mockResolvedValue(true);

    await expect(openGmailOAuth({ apiClient, openURL })).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    );

    expect(apiClient.startGoogleOAuth).toHaveBeenCalledWith({
      returnTo: '/#/gmail',
      scopes: GMAIL_SURFACE_SCOPES,
    });
    expect(gmailReturnTo()).toBe('/#/gmail');
  });

  describe('multiple Google accounts', () => {
    const work = {
      accountId: 'work',
      email: 'me@work.com',
      isDefault: true,
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
    };
    const home = {
      accountId: 'home',
      email: 'me@home.com',
      isDefault: false,
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
    };
    const side = { accountId: 'side', email: 'side@x.com', isDefault: false, grantedScopes: [] };
    const MULTI = {
      connected: true,
      email: 'me@work.com',
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
      serverConfigured: true,
      defaultAccountId: 'work',
      accounts: [work, home, side],
    };

    it('reads one inbox, or every readable inbox for All inboxes', async () => {
      const listGoogleGmailThreads = vi.fn(async (p: any) => ({
        threads: [{ id: `t-${p.account}`, snippet: p.account }],
      }));
      const one = await loadInboxThreads({ listGoogleGmailThreads }, 'home', [work, home, side]);
      expect(one.threads.map((t) => [t.id, t.accountEmail])).toEqual([['t-home', 'me@home.com']]);

      const all = await loadInboxThreads({ listGoogleGmailThreads }, '__all_inboxes__', [
        work,
        home,
        side,
      ]);
      expect(all.threads.map((t) => t.accountId)).toEqual(['work', 'home']);
    });

    it('shows the inbox switcher with All inboxes and labels threads by account', () => {
      const html = renderToStaticMarkup(
        <GmailContent
          loading={false}
          threadsLoading={false}
          error={null}
          status={MULTI}
          inbox="__all_inboxes__"
          threads={[
            {
              id: 't1',
              snippet: 'Quarterly numbers',
              accountId: 'work',
              accountEmail: 'me@work.com',
            },
            { id: 't2', snippet: 'Dinner?', accountId: 'home', accountEmail: 'me@home.com' },
          ]}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCompose={() => undefined}
          onOpenThread={() => undefined}
        />,
      );
      expect(html).toContain('Inbox All inboxes');
      expect(html).toContain('Inbox me@home.com');
      expect(html).toContain('Enable Gmail for side@x.com');
      expect(html).toContain('Dinner?');
      expect(html).toContain('me@home.com');
    });

    it('offers a From picker when several accounts can send', () => {
      const html = renderToStaticMarkup(
        <ComposeModal
          accounts={[work, home]}
          initialAccountId="home"
          saving={false}
          error={null}
          onClose={() => undefined}
          onSend={() => undefined}
        />,
      );
      expect(html).toContain('Send from me@work.com');
      expect(html).toContain('Send from me@home.com');
    });
  });
});
