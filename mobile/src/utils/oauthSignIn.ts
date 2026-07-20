/**
 * oauthSignIn.ts — native browser/OAuth sign-in for React Native.
 *
 * Per the `oauth-rn` epic decision: use expo-auth-session's native
 * ASWebAuthenticationSession / Android Custom Tabs (via expo-web-browser)
 * with a deep-link redirect back into the app — never a WebView.
 *
 * Flow (GitHub is the proven first provider):
 *   1. Build the app's deep-link redirect URI (agenthub://oauth-callback).
 *   2. Fetch the provider authorize URL from the Hub with auth headers
 *      attached (the `/start` call — NOT the browser navigating there).
 *   3. Open the authorize URL in the native auth session, watching for a
 *      redirect back to our deep link.
 *   4. The Hub callback exchanges the code, persists the connection, and
 *      302s to our deep link, which closes the browser and resolves here.
 *
 * Requires a custom Expo dev client / standalone build — the native auth
 * session and custom scheme do not work in Expo Go.
 */
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { api } from './api';
import {
  OAUTH_SCHEME,
  OAUTH_REDIRECT_PATH,
  interpretAuthSessionResult,
  type OAuthOutcome,
} from './oauthResult';

// Finish any auth session that was pending when the app was backgrounded
// (Android Custom Tabs). No-op on iOS. Safe to call at module load.
WebBrowser.maybeCompleteAuthSession();

/** The deep-link URI the OAuth callback redirects back to. */
export function getOAuthRedirectUri(): string {
  return makeRedirectUri({ scheme: OAUTH_SCHEME, path: OAUTH_REDIRECT_PATH });
}

/**
 * Run "Sign in with GitHub" end-to-end. Resolves with an {@link OAuthOutcome}
 * describing whether the connection completed, the user cancelled, or it
 * failed. On `ok`, callers should re-fetch `getGithubAuthStatus()`.
 */
export async function signInWithGithub(): Promise<OAuthOutcome> {
  const redirectUri = getOAuthRedirectUri();
  const { authorizeUrl } = await api.getGithubAuthStartUrl(redirectUri);
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri);
  return interpretAuthSessionResult(result);
}
