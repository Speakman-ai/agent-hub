import { createSign } from 'crypto';
import type { GitHubAppConfig } from './types.js';

interface JWTHeader {
  alg: string;
  typ: string;
}

interface JWTPayload {
  iss: string;
  iat: number;
  exp: number;
}

interface TokenCacheEntry {
  token: string;
  expiry: number;
}

interface GitHubApiRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  appId: string | number;
  privateKey: string;
  installationId: string | number;
}

interface GitHubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  hook_attributes: { url: string; active: boolean };
  description: string;
  public: boolean;
  setup_url: string;
  request_oauth_on_install: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

export function generateJWT(appId: string | number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header: JWTHeader = { alg: 'RS256', typ: 'JWT' };
  const payload: JWTPayload = {
    iss: String(appId),
    iat: now - 60,
    exp: now + 600,
  };

  const b64 = (obj: JWTHeader | JWTPayload): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(privateKey, 'base64url');

  return `${unsigned}.${signature}`;
}

const tokenCache = new Map<string, TokenCacheEntry>();

export async function getInstallationToken(
  appId: string | number,
  privateKey: string,
  installationId: string | number,
): Promise<string> {
  const key = String(installationId);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expiry > now + 5 * 60 * 1000) {
    return cached.token;
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

  const data = (await res.json()) as InstallationTokenResponse;
  const expiry = new Date(data.expires_at).getTime();
  tokenCache.set(key, { token: data.token, expiry });
  console.log(
    `[GitHub App] Installation token refreshed for ${installationId}, expires at ${data.expires_at}`,
  );
  return data.token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export function resolveInstallationId(
  githubAppConfig: GitHubAppConfig | null,
  owner?: string,
): string | number | null {
  if (!githubAppConfig) return null;
  if (owner && Array.isArray(githubAppConfig.installations)) {
    const match = githubAppConfig.installations.find(
      (inst) => inst.account?.toLowerCase() === owner.toLowerCase(),
    );
    if (match) return match.id;
  }
  return githubAppConfig.installationId || null;
}

export function buildAppManifest(serverUrl: string): GitHubAppManifest {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    name: 'Agent Hub Reviewer',
    url: base,
    redirect_url: `${base}/api/github-app/callback`,
    hook_attributes: { url: `${base}/api/webhooks/github`, active: true },
    description:
      'Automated PR reviews and merges for Agent Hub. Submits formal GitHub reviews (approve/request-changes) and merges approved PRs.',
    public: true,
    setup_url: `${base}/api/github-app/setup-complete`,
    request_oauth_on_install: false,
    default_permissions: {
      pull_requests: 'write',
      contents: 'write',
      issues: 'write',
      // `checks: write` lets us publish the Reviewer's progress as a first-class
      // Check Run (Cursor-parity progress panel in the PR Checks tab), not just
      // as a `pulls/{pr}/reviews` comment buried in the Conversation tab.
      checks: 'write',
      statuses: 'write',
    },
    default_events: [
      'pull_request',
      'pull_request_review',
      'check_suite',
      // `check_run` is the "Re-run" button on a specific check (e.g. the user
      // clicks Re-run on "Agent Hub Reviewer" alone); `check_suite.rerequested`
      // handles the umbrella "Re-run all checks" button.
      'check_run',
    ],
  };
}

export async function githubApiRequest(
  endpoint: string,
  { method = 'GET', body, appId, privateKey, installationId }: GitHubApiRequestOptions,
): Promise<Record<string, unknown>> {
  const token = await getInstallationToken(appId, privateKey, installationId);
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${endpoint} failed (${res.status}): ${text}`);
  }

  if (res.status === 204) return {};
  return (await res.json()) as Record<string, unknown>;
}

export async function getAppInfo(
  appId: string | number,
  privateKey: string,
): Promise<Record<string, unknown>> {
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

  return (await res.json()) as Record<string, unknown>;
}

export async function getAppInstallations(
  appId: string | number,
  privateKey: string,
): Promise<Array<Record<string, unknown>>> {
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

  return (await res.json()) as Array<Record<string, unknown>>;
}
