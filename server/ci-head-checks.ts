import { githubApiRequest, resolveInstallationId } from './github-app.js';
import type { CheckRunCiRow } from './ci-conclusions.js';
import type { AppConfig } from './types.js';

function parseCheckRunsPayload(raw: unknown): CheckRunCiRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const runs = (raw as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(runs)) return [];
  const out: CheckRunCiRow[] = [];
  for (const row of runs) {
    if (!row || typeof row !== 'object') continue;
    const chk = row as Record<string, unknown>;
    const id = typeof chk.id === 'number' ? chk.id : null;
    const name = typeof chk.name === 'string' ? chk.name : null;
    if (id == null || !name) continue;
    const conclusion = typeof chk.conclusion === 'string' ? chk.conclusion : null;
    out.push({ id, name, conclusion });
  }
  return out;
}

/**
 * List check runs for a commit SHA (GitHub App installation auth).
 * Returns [] when the App is not installed or the API call fails.
 */
export async function fetchCommitCheckRunsForCi(
  appConfig: AppConfig,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CheckRunCiRow[]> {
  const app = appConfig.githubApp;
  if (!app) return [];
  const installationId = resolveInstallationId(app, owner);
  if (!installationId) return [];
  try {
    const data = await githubApiRequest(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
      {
        appId: app.appId,
        privateKey: app.privateKey,
        installationId,
      },
    );
    return parseCheckRunsPayload(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ci-head-checks] fetch failed owner=${owner} repo=${repo} sha=${headSha.slice(0, 7)}: ${message}`,
    );
    return [];
  }
}
