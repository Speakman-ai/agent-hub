import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));

import { DraftCard } from './SessionChatDraftsPanel';

const DRAFT = {
  id: 'd-1',
  sessionId: 's-1',
  spaceId: 'AAA',
  threadName: 'spaces/AAA/threads/T1',
  text: 'Staging is reset.',
  revision: 1,
  status: 'pending' as const,
  error: null,
  sentMessageName: null,
  createdAt: '2026-10-08T10:00:00Z',
  updatedAt: '2026-10-08T10:00:00Z',
};

describe('SessionChatDraftsPanel DraftCard (mobile)', () => {
  it('shows the draft text with Approve, Edit, and Discard', () => {
    const html = renderToStaticMarkup(<DraftCard draft={DRAFT} onChanged={() => {}} />);
    expect(html).toContain('awaiting your approval');
    expect(html).toContain('thread reply');
    expect(html).toContain('Staging is reset.');
    expect(html).toContain('Approve and send');
    expect(html).toContain('Edit');
    expect(html).toContain('Discard');
  });

  it('shows the last send failure', () => {
    const html = renderToStaticMarkup(
      <DraftCard
        draft={{ ...DRAFT, error: 'Google Chat rate limit exceeded' }}
        onChanged={() => {}}
      />,
    );
    expect(html).toContain('Google Chat rate limit exceeded');
  });

  it('offers only Retry send and Discard for an unconfirmed send', () => {
    const html = renderToStaticMarkup(
      <DraftCard draft={{ ...DRAFT, status: 'unconfirmed' }} onChanged={() => {}} />,
    );
    expect(html).toContain('send not confirmed');
    expect(html).toContain('Retry send');
    expect(html).toContain('Discard');
    expect(html).not.toContain('>Edit<');
  });
});
