import { describe, it, expect } from 'vitest';
import {
  CHAT_MESSAGES_CREATE_SCOPE,
  CHAT_MESSAGES_READONLY_SCOPE,
  CHAT_MEMBERSHIPS_READONLY_SCOPE,
  CHAT_MEMBERSHIPS_SCOPE,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_READONLY_SCOPE,
  CHAT_SPACES_SCOPE,
  CHAT_REACTIONS_SCOPE,
  CHAT_READSTATE_SCOPE,
  CHAT_READSTATE_READONLY_SCOPE,
  chatConsent,
} from './googleSurface';

const status = (grantedScopes: string[]) => ({ connected: true, grantedScopes });

describe('chatConsent', () => {
  it('reports every missing scope when nothing is granted', () => {
    expect(chatConsent(status([]))).toEqual({
      canRead: false,
      canSend: false,
      missingRead: [CHAT_SPACES_READONLY_SCOPE, CHAT_MESSAGES_READONLY_SCOPE],
      missingSend: [CHAT_MESSAGES_CREATE_SCOPE],
      missingNames: [CHAT_MEMBERSHIPS_READONLY_SCOPE],
      canReact: false,
      canReadState: false,
      canWriteReadState: false,
      missingExtras: [CHAT_REACTIONS_SCOPE, CHAT_READSTATE_SCOPE],
    });
    expect(chatConsent(null).missingRead).toHaveLength(2);
  });

  it('read-only grant: can read, and sending has a scope to request', () => {
    expect(chatConsent(status([CHAT_SPACES_READONLY_SCOPE, CHAT_MESSAGES_READONLY_SCOPE]))).toEqual(
      {
        canRead: true,
        canSend: false,
        missingRead: [],
        missingSend: [CHAT_MESSAGES_CREATE_SCOPE],
        missingNames: [CHAT_MEMBERSHIPS_READONLY_SCOPE],
        canReact: false,
        canReadState: false,
        canWriteReadState: false,
        missingExtras: [CHAT_REACTIONS_SCOPE, CHAT_READSTATE_SCOPE],
      },
    );
  });

  it('partial read grant lists only the missing read scope', () => {
    const c = chatConsent(status([CHAT_SPACES_READONLY_SCOPE, CHAT_MESSAGES_CREATE_SCOPE]));
    expect(c.canRead).toBe(false);
    expect(c.canSend).toBe(true);
    expect(c.missingRead).toEqual([CHAT_MESSAGES_READONLY_SCOPE]);
    expect(c.missingSend).toEqual([]);
  });

  it('broad scopes satisfy both read and send', () => {
    expect(
      chatConsent(status([CHAT_SPACES_SCOPE, CHAT_MESSAGES_SCOPE, CHAT_MEMBERSHIPS_SCOPE])),
    ).toEqual({
      canRead: true,
      canSend: true,
      missingRead: [],
      missingSend: [],
      missingNames: [],
      // chat.messages covers reactions; read state has no broader scope.
      canReact: true,
      canReadState: false,
      canWriteReadState: false,
      missingExtras: [CHAT_READSTATE_SCOPE],
    });
  });

  it('the readonly read-state scope shows the Unread line but cannot mark read', () => {
    const c = chatConsent(status([CHAT_READSTATE_READONLY_SCOPE, CHAT_REACTIONS_SCOPE]));
    expect(c.canReact).toBe(true);
    expect(c.canReadState).toBe(true);
    expect(c.canWriteReadState).toBe(false);
    expect(c.missingExtras).toEqual([CHAT_READSTATE_SCOPE]);
  });
});
