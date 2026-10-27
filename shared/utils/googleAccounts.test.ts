import { describe, expect, it } from 'vitest';
import {
  ALL_INBOXES,
  buildGmailReplyBody,
  effectiveHiddenAccounts,
  splitMailboxes,
  emailAddressOf,
  fetchAcrossGoogleAccounts,
  googleAccountColor,
  googleAccountParam,
  inboxAccounts,
  linkedGoogleAccounts,
  mergeAccountEvents,
  parseHiddenAccounts,
  resolveInboxSelection,
  toggleHiddenAccount,
  withoutHiddenAccounts,
  type LinkedGoogleAccount,
} from './googleAccounts';

const work: LinkedGoogleAccount = {
  accountId: 'acc-work',
  email: 'me@work.com',
  isDefault: true,
  grantedScopes: ['mail'],
};
const home: LinkedGoogleAccount = {
  accountId: 'acc-home',
  email: 'me@home.com',
  isDefault: false,
  grantedScopes: ['mail'],
};
const noMail: LinkedGoogleAccount = {
  accountId: 'acc-x',
  email: 'x@x.com',
  isDefault: false,
  grantedScopes: [],
};
const canRead = (a: LinkedGoogleAccount) => a.grantedScopes.includes('mail');

describe('linkedGoogleAccounts', () => {
  it('puts the default account first', () => {
    const out = linkedGoogleAccounts({
      connected: true,
      defaultAccountId: 'acc-work',
      accounts: [
        { accountId: 'acc-home', email: 'me@home.com', isDefault: false, grantedScopes: [] },
        { accountId: 'acc-work', email: 'me@work.com', isDefault: true, grantedScopes: [] },
      ],
    });
    expect(out.map((a) => a.accountId)).toEqual(['acc-work', 'acc-home']);
  });

  it('builds one account from the top-level fields when `accounts` is missing', () => {
    expect(
      linkedGoogleAccounts({ connected: true, email: 'solo@x.com', grantedScopes: ['s'] }),
    ).toEqual([{ accountId: '', email: 'solo@x.com', isDefault: true, grantedScopes: ['s'] }]);
    expect(googleAccountParam({ accountId: '' })).toBeUndefined();
  });

  it('returns nothing when not connected', () => {
    expect(linkedGoogleAccounts({ connected: false })).toEqual([]);
    expect(linkedGoogleAccounts(null)).toEqual([]);
  });
});

describe('googleAccountColor', () => {
  it('assigns colors by position and gray for unknown accounts', () => {
    const accounts = [work, home];
    expect(googleAccountColor(accounts, 'acc-work')).not.toBe(
      googleAccountColor(accounts, 'acc-home'),
    );
    expect(googleAccountColor(accounts, 'nope')).toBe('#6b7280');
  });
});

describe('fetchAcrossGoogleAccounts + mergeAccountEvents', () => {
  it('merges events from every account by start and keeps going past a failure', async () => {
    const byAccount: Record<string, Array<{ id: string; start: { dateTime: string } }>> = {
      'acc-work': [{ id: 'w2', start: { dateTime: '2026-07-07T15:00:00Z' } }],
      'acc-home': [{ id: 'h1', start: { dateTime: '2026-07-07T09:00:00Z' } }],
    };
    const { items, failures } = await fetchAcrossGoogleAccounts([work, home, noMail], async (a) => {
      if (a.accountId === 'acc-x') throw new Error('scope required');
      return byAccount[a.accountId];
    });
    const merged = mergeAccountEvents(items);
    expect(merged.map((e) => [e.id, e.accountEmail])).toEqual([
      ['h1', 'me@home.com'],
      ['w2', 'me@work.com'],
    ]);
    expect(failures).toEqual([{ account: noMail, error: 'scope required' }]);
  });
});

describe('hidden accounts', () => {
  it('filters and toggles', () => {
    const items = [{ accountId: 'a' }, { accountId: 'b' }];
    expect(withoutHiddenAccounts(items, ['a'])).toEqual([{ accountId: 'b' }]);
    expect(toggleHiddenAccount(['a'], 'a')).toEqual([]);
    expect(toggleHiddenAccount([], 'a')).toEqual(['a']);
    expect(parseHiddenAccounts('["a",3]')).toEqual(['a']);
    expect(parseHiddenAccounts('{bad')).toEqual([]);
  });
});

describe('inbox selection', () => {
  it('only offers All inboxes with two readable accounts', () => {
    expect(resolveInboxSelection(ALL_INBOXES, [work, home], canRead)).toBe(ALL_INBOXES);
    expect(resolveInboxSelection(ALL_INBOXES, [work, noMail], canRead)).toBe('acc-work');
  });

  it('keeps a valid selection and falls back to the default', () => {
    expect(resolveInboxSelection('acc-home', [work, home], canRead)).toBe('acc-home');
    expect(resolveInboxSelection('gone', [work, home], canRead)).toBe('acc-work');
    expect(resolveInboxSelection(null, [{ ...work, grantedScopes: [] }, home], canRead)).toBe(
      'acc-home',
    );
  });

  it('reads every readable account for All inboxes', () => {
    expect(inboxAccounts(ALL_INBOXES, [work, home, noMail], canRead)).toEqual([work, home]);
    expect(inboxAccounts('acc-home', [work, home], canRead)).toEqual([home]);
  });
});

describe('buildGmailReplyBody', () => {
  it('replies to the last sender with threading headers', () => {
    expect(emailAddressOf('Jane <jane@example.com>')).toBe('jane@example.com');
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'me@home.com',
      text: 'Sounds good',
      messages: [
        { from: 'Jane <jane@example.com>', subject: 'Lunch', messageIdHeader: '<m1@x>' },
        { from: 'Bob <bob@example.com>', subject: 'Re: Lunch', messageIdHeader: '<m2@x>' },
      ],
    });
    expect(body).toEqual({
      to: ['bob@example.com'],
      subject: 'Re: Lunch',
      text: 'Sounds good',
      threadId: 't1',
      inReplyTo: '<m2@x>',
      references: '<m2@x>',
    });
  });

  it('replies to the recipient when the last message was sent by the account itself', () => {
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'ME@home.com',
      text: 'ping',
      messages: [{ from: 'Me <me@home.com>', to: 'Jane <jane@example.com>, x@y.com' }],
    });
    expect(body?.to).toEqual(['jane@example.com']);
    expect(body?.subject).toBe('Re:');
  });

  it('keeps a quoted display name with a comma intact when replying to the recipient', () => {
    expect(splitMailboxes('"Doe, Jane" <jane@example.com>, Bob <bob@x.com>')).toEqual([
      '"Doe, Jane" <jane@example.com>',
      'Bob <bob@x.com>',
    ]);
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'me@home.com',
      text: 'ping',
      messages: [{ from: 'me@home.com', to: '"Doe, Jane" <jane@example.com>' }],
    });
    expect(body?.to).toEqual(['jane@example.com']);
  });
});

describe('effectiveHiddenAccounts', () => {
  it('ignores the stored list once only one account is linked', () => {
    expect(effectiveHiddenAccounts(['a'], [{ accountId: 'a' }])).toEqual([]);
    expect(
      effectiveHiddenAccounts(['a', 'gone'], [{ accountId: 'a' }, { accountId: 'b' }]),
    ).toEqual(['a']);
  });
});

describe('buildGmailReplyBody Reply-To', () => {
  it('replies to Reply-To instead of From on incoming mail', () => {
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'me@home.com',
      text: 'Thanks',
      messages: [
        {
          from: 'Notifications <notifications@example.com>',
          replyTo: '"Person, A" <person@example.com>',
          subject: 'Update',
        },
      ],
    });
    expect(body?.to).toEqual(['person@example.com']);
  });

  it('replies to every Reply-To address', () => {
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'me@home.com',
      text: 'x',
      messages: [{ from: 'a@x.com', replyTo: 'b@x.com, C <c@x.com>' }],
    });
    expect(body?.to).toEqual(['b@x.com', 'c@x.com']);
  });

  it("ignores Reply-To on the account's own sent message", () => {
    const body = buildGmailReplyBody({
      threadId: 't1',
      accountEmail: 'me@home.com',
      text: 'x',
      messages: [{ from: 'me@home.com', to: 'jane@x.com', replyTo: 'me-alias@home.com' }],
    });
    expect(body?.to).toEqual(['jane@x.com']);
  });
});
