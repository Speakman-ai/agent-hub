/**
 * Test double for `google-chat-account.ts` that answers from a mocked
 * connection store, for Chat route tests that predate the Chat account
 * binding and only stub `getGoogleConnectionStatus` / `getActiveAccessToken`
 * / `getGoogleConnection`. The Chat account is whatever account those stubs
 * describe.
 *
 *   vi.mock('../google-chat-account.js', async () =>
 *     (await import('../test/chat-account-mock.js')).chatAccountFromConnectionStore(
 *       connectionStoreMock,
 *     ),
 *   );
 */
type Fn = (...args: never[]) => unknown;

interface ConnectionStoreStubs {
  getGoogleConnectionStatus?: Fn;
  getActiveAccessToken?: Fn;
  getGoogleConnection?: Fn;
}

export function chatAccountFromConnectionStore(store: ConnectionStoreStubs) {
  const call = (fn: Fn | undefined, ...args: unknown[]) =>
    fn ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
  return {
    isWorkspaceAccount: () => true,
    getChatAccountSummary: () => null,
    getChatConnectionStatus: (userId: string) => call(store.getGoogleConnectionStatus, userId),
    getChatAccessToken: (userId: string, creds: unknown) =>
      call(store.getActiveAccessToken, userId, creds),
    getChatAccessIdentity: async (userId: string, creds: unknown) => {
      const token = (await call(store.getActiveAccessToken, userId, creds)) as string | null;
      const conn = call(store.getGoogleConnection, userId) as { googleSub?: string } | null;
      return token ? { token, sub: conn?.googleSub ?? null } : null;
    },
    getChatAccountSub: (userId: string) =>
      (call(store.getGoogleConnection, userId) as { googleSub?: string } | null | undefined)
        ?.googleSub ?? null,
    getChatAccount: () => null,
    getChatAccountBinding: () => ({ account: null, boundEmail: null }),
    setChatAccount: () => ({ ok: false, code: 'google_account_not_found' }),
    bindChatAccountIfUnbound: () => false,
  };
}
