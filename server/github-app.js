/**
 * GitHub App authentication and token management.
 *
 * Handles the GitHub App Manifest flow for one-click setup, JWT generation
 * for app-level auth, and installation access token caching for API calls.
 *
 * Used by the review system to submit formal PR reviews (approve/request-changes)
 * and merges, bypassing GitHub's same-account review limitation.
 */

import { createSign } from 'crypto';

// ─── JWT Generation ─────────────────────────────────────────────────────────
// GitHub Apps authenticate via RS256-signed JWTs (max 10-min lifetime).

/**
 * Generate a RS256-signed JWT for GitHub App authentication.
 * @param {string|number} appId - GitHub App ID
 * @param {string} privateKey - PEM-encoded RSA private key
 * @returns {string} Signed JWT
 */
export function generateJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: String(appId),
    iat: now - 60, // Backdate 60s for clock drift
    exp: now + 600, // 10-minute max lifetime
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(privateKey, 'base64url');

  return `${unsigned}.${signature}`;
}

// ─── Installation Token Cache ───────────────────────────────────────────────
// Installation tokens are valid for 1 hour. We cache and refresh 5 min early.

let cachedToken = null;
let cachedTokenExpiry = 0;
let cachedInstallationId = null;

/**
 * Get a valid installation access token, refreshing if needed.
 * @param {string|number} appId
 * @param {string} privateKey - PEM-encoded RSA private key
 * @param {string|number} installationId
 * @returns {Promise<string>} Installation access token
 */
export async function getInstallationToken(appId, privateKey, installationId) {
  // Return cached token if it's still valid (with 5-min buffer) and matches this installation
  const now = Date.now();
  if (
    cachedToken &&
    cachedTokenExpiry > now + 5 * 60 * 1000 &&
    String(cachedInstallationId) === String(installationId)
  ) {
    return cachedToken;
  }

  const jwt = generateJWT(appId, privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to get installation token (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  cachedTokenExpiry = new Date(data.expires_at).getTime();
  cachedInstallationId = installationId;
  console.log(`[GitHub App] Installation token refreshed, expires at ${data.expires_at}`);
  return cachedToken;
}

/**
 * Clear the cached installation token (e.g. on config change).
 */
export function clearTokenCache() {
  cachedToken = null;
  cachedTokenExpiry = 0;
  cachedInstallationId = null;
}

// ─── App Manifest ───────────────────────────────────────────────────────────

/**
 * Build the GitHub App manifest JSON for the manifest creation flow.
 * @param {string} serverUrl - The public URL of this Agent Hub server
 * @returns {object} Manifest object
 */
export function buildAppManifest(serverUrl) {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    name: 'Agent Hub Reviewer',
    url: base,
    redirect_url: `${base}/api/github-app/callback`,
    hook_attributes: { url: `${base}/api/webhooks/github`, active: true },
    description:
      'Automated PR reviews and merges for Agent Hub. Submits formal GitHub reviews (approve/request-changes) and merges approved PRs.',
    public: false,
    default_permissions: {
      pull_requests: 'write',
      contents: 'write',
      issues: 'write',
    },
    default_events: ['pull_request', 'pull_request_review', 'check_suite'],
  };
}

// ─── GitHub API Helpers (using installation token) ──────────────────────────

/**
 * Make an authenticated GitHub API request using the installation token.
 * @param {string} endpoint - API path (e.g. '/repos/owner/repo/pulls/1/reviews')
 * @param {object} options - { method, body, appId, privateKey, installationId }
 * @returns {Promise<object>} Parsed JSON response
 */
export async function githubApiRequest(
  endpoint,
  { method = 'GET', body, appId, privateKey, installationId },
) {
  const token = await getInstallationToken(appId, privateKey, installationId);
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${endpoint} failed (${res.status}): ${text}`);
  }

  // Some endpoints return 204 No Content
  if (res.status === 204) return {};
  return res.json();
}

/**
 * Get the authenticated app's metadata (name, slug, owner, etc.).
 * @param {string|number} appId
 * @param {string} privateKey
 * @returns {Promise<object>} App metadata from GET /app
 */
export async function getAppInfo(appId, privateKey) {
  const jwt = generateJWT(appId, privateKey);
  const res = await fetch('https://api.github.com/app', {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to get app info (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * List installations for the authenticated app.
 * @param {string|number} appId
 * @param {string} privateKey
 * @returns {Promise<Array>} List of installation objects
 */
export async function getAppInstallations(appId, privateKey) {
  const jwt = generateJWT(appId, privateKey);
  const res = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to list installations (${res.status}): ${text}`);
  }

  return res.json();
}
