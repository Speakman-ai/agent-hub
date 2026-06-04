/**
 * pr-read-fetch.ts — Server-side PR diff / changed-files for the PR read proxy.
 *
 * Strictly per-user: reads use the acting user's own OAuth/PAT.
 */

import type { AppConfig } from './types.js';
import { CONNECT_GITHUB_HINT } from './github-auth-policy.js';

const GH_API_BASE = 'https://api.github.com';
const USER_AGENT = 'agent-hub';
const API_VERSION = '2022-11-28';

export interface PrReadFetchOptions {
  userAccessToken?: string | null;
  fetchImpl?: typeof fetch;
}

export type PrReadSource = 'user-oauth';

export interface PrDiffResult {
  source: PrReadSource;
  diff: string;
}

export interface PrFilesEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url?: string;
  raw_url?: string;
  sha?: string;
  previous_filename?: string;
}

export interface PrFilesResult {
  source: PrReadSource;
  files: PrFilesEntry[];
  truncated: boolean;
}

export class PrReadFetchError extends Error {
  appTierError?: string;
  constructor(message: string, opts?: { appTierError?: string | null }) {
    super(message);
    this.name = 'PrReadFetchError';
    if (opts?.appTierError) this.appTierError = opts.appTierError;
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

async function fetchText(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.text();
}

async function fetchJson<T = unknown>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function fetchPrDiff(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrReadFetchOptions,
): Promise<PrDiffResult> {
  const f = opts?.fetchImpl ?? fetch;
  const path = `/repos/${repo.owner}/${repo.repo}/pulls/${num}`;

  if (opts?.userAccessToken) {
    try {
      const diff = await fetchText(
        `${GH_API_BASE}${path}`,
        {
          Authorization: `Bearer ${opts.userAccessToken}`,
          Accept: 'application/vnd.github.v3.diff',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
        f,
      );
      return { source: 'user-oauth', diff };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PrReadFetchError(msg.split('\n')[0]);
    }
  }

  throw new PrReadFetchError(CONNECT_GITHUB_HINT);
}

export async function fetchPrFiles(
  config: AppConfig,
  repo: { owner: string; repo: string },
  num: number,
  opts?: PrReadFetchOptions,
): Promise<PrFilesResult> {
  const f = opts?.fetchImpl ?? fetch;

  async function paginate(
    headers: Record<string, string>,
    source: PrReadSource,
  ): Promise<PrFilesResult> {
    const all: PrFilesEntry[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${GH_API_BASE}/repos/${repo.owner}/${repo.repo}/pulls/${num}/files?per_page=${PAGE_SIZE}&page=${page}`;
      const batch = await fetchJson<PrFilesEntry[]>(url, headers, f);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) return { source, files: all, truncated };
      if (page === MAX_PAGES) truncated = true;
    }
    return { source, files: all, truncated };
  }

  if (opts?.userAccessToken) {
    try {
      return await paginate(
        {
          Authorization: `Bearer ${opts.userAccessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
        'user-oauth',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PrReadFetchError(msg.split('\n')[0]);
    }
  }

  throw new PrReadFetchError(CONNECT_GITHUB_HINT);
}
