// Pure helpers for the Settings → My CLI Keys tab (mobile). Mirrors the
// per-user credential routes in server/routes/auth.ts:
//   GET/PUT /api/auth/me/claude-auth   → { anthropicApiKey, claudeCodeOAuthToken, ... }
//   GET/PUT /api/auth/me/cursor-auth   → { engine, apiKey, hostConfigFallback }
//   GET/PUT /api/auth/me/gemini-auth   → same single-key shape
//   GET/PUT /api/auth/me/codex-auth    → single-key shape + deviceLogin.uiStatus
// plus GitHub connection status (server/routes/github-oauth.ts):
//   GET /api/auth/github/status → { connected, login, connectedAt, serverConfigured }
//   DELETE /api/auth/github     → { ok: true }
/** Static descriptor list driving one card per provider. */
export const CLI_KEY_PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    keyLabel: 'Anthropic API key',
    placeholder: 'sk-ant-...',
    description: 'Used when sessions you own spawn the Claude Code CLI.',
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    keyLabel: 'Cursor API key',
    placeholder: 'key_...',
    description: 'Used when sessions you own spawn the Cursor Agent CLI.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    keyLabel: 'Gemini API key',
    placeholder: 'AIza...',
    description: 'Used when sessions you own spawn the Gemini CLI.',
  },
  {
    id: 'codex',
    label: 'Codex',
    keyLabel: 'OpenAI API key',
    placeholder: 'sk-...',
    description: 'Used when sessions you own spawn the Codex CLI.',
  },
  {
    id: 'grok',
    label: 'Grok',
    keyLabel: 'xAI API key',
    placeholder: 'xai-...',
    description:
      'Used when sessions you own spawn the Grok Build CLI. On web/desktop you can ' +
      'instead "Sign in with browser" (xAI device-code OAuth); on mobile, paste a key.',
  },
];
/**
 * Whether a GET /auth/me/<provider>-auth body indicates a stored credential.
 * Claude has two slots (API key + OAuth token); the others a single apiKey.
 * Masked values are non-empty strings when configured, null otherwise.
 */
export function providerKeyConfigured(provider: any, body: any) {
  if (!body) return false;
  if (provider === 'claude') {
    return !!(body.anthropicApiKey || body.claudeCodeOAuthToken);
  }
  return !!body.apiKey;
}
/**
 * Status line for a provider card. Includes the masked key when present and
 * notes a host-config fallback for engines that have one (Gemini).
 */
export function providerStatusLabel(provider: any, body: any) {
  if (!body) return 'Not configured';
  if (provider === 'claude') {
    const parts = [];
    if (body.anthropicApiKey) parts.push(`API key ${body.anthropicApiKey}`);
    if (body.claudeCodeOAuthToken) {
      parts.push(body.claudeCodeOAuthExpired ? 'OAuth token (expired)' : 'OAuth token configured');
    }
    return parts.length > 0 ? parts.join(' · ') : 'Not configured';
  }
  if (body.apiKey) return `API key ${body.apiKey}`;
  if (body.hostConfigFallback?.apiKey) return 'Using host-configured key';
  return 'Not configured';
}
/**
 * Body for PUT /auth/me/<provider>-auth that sets (or clears, when `key` is
 * empty) the API key. Claude writes `anthropicApiKey`; the single-key
 * engines write `apiKey`. Empty string → null (server clears the slot).
 */
export function buildPutMyAuthBody(provider: any, key: any) {
  const value = (key || '').trim() || null;
  return provider === 'claude' ? { anthropicApiKey: value } : { apiKey: value };
}
/**
 * Human label for the Codex deviceLogin.uiStatus enum
 * (server/codex-device-auth-parse.ts: 'missing' | 'pending' | 'authenticated'),
 * null when the field is absent. Falls back to the raw value for any future
 * status so the UI never hides server state.
 */
export function codexDeviceLoginLabel(body: any) {
  const uiStatus = body?.deviceLogin?.uiStatus;
  if (!uiStatus) return null;
  if (uiStatus === 'authenticated') {
    return body?.deviceLogin?.oauth?.loggedIn ? 'Signed in with ChatGPT' : 'Authenticated';
  }
  const labels: Record<string, any> = {
    pending: 'Sign-in in progress…',
    missing: 'Not signed in',
  };
  return labels[uiStatus] || String(uiStatus).replace(/_/g, ' ');
}
/** "Connected as @login" / "Not connected" for the GitHub card. */
export function githubStatusLabel(status: any) {
  if (!status) return 'Not connected';
  if (status.connected) {
    return status.login ? `Connected as @${status.login}` : 'Connected';
  }
  return 'Not connected';
}
