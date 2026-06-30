import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
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

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));

import {
  buildSendBody,
  gmailReturnTo,
  GmailContent,
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
});
