/**
 * Signing out of one server, pinned to that server from the moment it starts.
 *
 * Sign-out waits for the push unregister (up to the request timeout), and the
 * user can switch servers meanwhile. So the server and its login are captured
 * up front and everything after acts on them, never on whatever is active by
 * then: only that login is cleared, the logout call goes to that server, and
 * the active UI is only reset if that server is still the active one.
 */
import { authOriginOf, captureLogin, getToken, hasLoginFor, logoutLogin } from './auth';
import type { PushRegistrar } from './pushRegistrar';

export async function signOutOfServer(args: {
  /** The server to sign out of, read by the caller when the user asked. */
  serverUrl: string;
  registrar: Pick<PushRegistrar, 'signOut'>;
  /** The active server when sign-out finishes. */
  currentServerUrl: () => string | null | undefined;
  /**
   * Runs only if this sign-out still owns the auth state when it ends:
   * `serverUrl` is still the active server and nothing has signed in to it
   * since. A newer login or a switch elsewhere suppresses it.
   */
  onSignedOutWhileActive: () => void;
}): Promise<boolean> {
  const { serverUrl } = args;
  const login = await captureLogin(serverUrl);
  await args.registrar.signOut(serverUrl, () => logoutLogin(login));
  // Checked synchronously, after the last await, against the live state.
  const stillOwned =
    authOriginOf(args.currentServerUrl()) === authOriginOf(serverUrl) &&
    !hasLoginFor(serverUrl) &&
    getToken() === null;
  if (stillOwned) args.onSignedOutWhileActive();
  return stillOwned;
}
