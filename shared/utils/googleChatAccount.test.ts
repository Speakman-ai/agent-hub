import { describe, it, expect } from 'vitest';
import {
  chatAccountChoices,
  chatAccountNotice,
  chatConsentAccountId,
  chatScopedStatus,
  type GoogleChatAccountState,
} from './googleChatAccount';

const CHAT_READ = 'https://www.googleapis.com/auth/chat.messages.readonly';

const state = (over: Partial<GoogleChatAccountState> = {}): GoogleChatAccountState => ({
  account: { accountId: 'b', email: 'b@work.example' },
  boundEmail: 'b@work.example',
  candidates: [
    {
      accountId: 'a',
      email: 'a@gmail.com',
      isDefault: true,
      workspace: false,
      hasChatScope: false,
    },
    {
      accountId: 'b',
      email: 'b@work.example',
      isDefault: false,
      workspace: true,
      hasChatScope: true,
    },
    {
      accountId: 'c',
      email: 'c@work.example',
      isDefault: false,
      workspace: true,
      hasChatScope: false,
    },
  ],
  ...over,
});

describe('chat account helpers', () => {
  it('offers only Workspace accounts, current first', () => {
    expect(chatAccountChoices(state()).map((c) => c.accountId)).toEqual(['b', 'c']);
  });

  it('explains a missing grant and a bound account that is no longer linked', () => {
    expect(chatAccountNotice(state())).toBeNull();
    expect(
      chatAccountNotice(state({ account: { accountId: 'c', email: 'c@work.example' } })),
    ).toMatch(/not been granted for c@work.example/);
    expect(chatAccountNotice(state({ account: null, boundEmail: 'gone@work.example' }))).toMatch(
      /gone@work.example, which is no longer linked/,
    );
    expect(chatAccountNotice(state({ account: null, boundEmail: null }))).toBeNull();
  });

  it("reads Chat consent from the Chat account's scopes, not the default's", () => {
    const status = {
      connected: true,
      email: 'default@x.example',
      grantedScopes: [CHAT_READ],
      chatAccount: { accountId: 'b', email: 'b@work.example', grantedScopes: [], bound: true },
    };
    expect(chatScopedStatus(status)).toMatchObject({ email: 'b@work.example', grantedScopes: [] });
    expect(chatConsentAccountId(status)).toBe('b');
    // Older servers send no chatAccount: unchanged.
    const legacy = { connected: true, grantedScopes: [CHAT_READ] };
    expect(chatScopedStatus(legacy)).toBe(legacy);
    expect(chatConsentAccountId(legacy)).toBeUndefined();
  });
});
