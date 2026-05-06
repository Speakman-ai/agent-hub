/**
 * `verify` adapter.
 *
 * Re-runs the validator's six probes (docker / nginx / cert / github-app
 * / route53 / webhook) and translates any red rows into RemediationCards
 * the orchestrator surfaces on the terminal `done` event. Per the
 * orchestrator contract, the verify phase ALWAYS returns
 * `status: 'ok'` — verify failures downgrade the run from
 * `done.ok` → `done.partial`, they do NOT emit `done.error`.
 *
 * The probes are exposed as the same `ValidateAdapters` shape the route
 * uses, so production wires the existing default adapters and tests can
 * inject deterministic results.
 */

import type { ExecutorPhaseResult, RemediationCard } from './orchestrator.js';

export interface VerifyCheck {
  name: string;
  pass: boolean;
  message: string;
}

/**
 * Adapter contract — production passes the existing `defaultCheck*`
 * helpers from `routes/pr-env-settings.ts`. Tests pass closures.
 */
export interface VerifyAdapters {
  checkDocker(): Promise<VerifyCheck>;
  checkNginx(
    sitesAvailable: string,
    sitesEnabled: string,
    baseVhostPath: string,
  ): Promise<VerifyCheck>;
  checkCert(certPath: string): Promise<VerifyCheck>;
  checkGithubApp(appId: string, privateKey: string, installationId: string): Promise<VerifyCheck>;
  checkRoute53(
    accessKeyId: string,
    secretAccessKey: string,
    hostedZoneId: string,
  ): Promise<VerifyCheck>;
  checkWebhook(): Promise<VerifyCheck>;
}

export interface VerifyOptions {
  adapters: VerifyAdapters;
  /** Resolved nginx paths from `write-tier3-config`. */
  nginxPaths: { sitesAvailableDir: string; sitesEnabledDir: string; baseVhostPath: string };
  /** Resolved cert path from `write-tier3-config`. */
  certPath: string;
  /** GitHub Reviewer App config — empty strings when unset. */
  githubApp: { appId: string; installationId: string; privateKey: string };
  /** Route 53 IAM credentials (empty when relying on instance role / IMDS). */
  route53: { accessKeyId: string; secretAccessKey: string; hostedZoneId: string };
  /** Carried-forward IAM card from `attach-iam` (path B). */
  pendingRemediations?: RemediationCard[];
  log?: (line: string) => void;
}

const REQUIRED_CHECKS = new Set(['cert', 'nginx', 'github-app', 'route53', 'webhook']);

const CHECK_TO_REMEDIATION: Record<string, RemediationCard['check']> = {
  cert: 'cert',
  nginx: 'nginx',
  'github-app': 'github-app',
  route53: 'route53',
  webhook: 'webhook',
  docker: 'docker',
};

function failureToCard(check: VerifyCheck): RemediationCard {
  const target = CHECK_TO_REMEDIATION[check.name] ?? 'docker';
  return {
    check: target,
    severity: REQUIRED_CHECKS.has(check.name) ? 'red' : 'amber',
    headline: `${check.name} check failed`,
    detail: check.message,
    actions: [
      {
        label: 'Re-run verify',
        kind: 'retry',
      },
      ...(target === 'github-app'
        ? [
            {
              label: 'Open GitHub App settings',
              kind: 'open-settings' as const,
              payload: '/settings/github-app',
            },
          ]
        : []),
      ...(target === 'webhook'
        ? [
            {
              label: 'Open project settings',
              kind: 'open-settings' as const,
              payload: '/settings/projects',
            },
          ]
        : []),
    ],
  };
}

export async function verifyPhase(opts: VerifyOptions): Promise<ExecutorPhaseResult> {
  const log = opts.log ?? (() => {});
  const { adapters, nginxPaths, certPath, githubApp, route53 } = opts;

  const results = await Promise.all([
    adapters
      .checkDocker()
      .catch((err: Error): VerifyCheck => ({ name: 'docker', pass: false, message: err.message })),
    adapters
      .checkNginx(
        nginxPaths.sitesAvailableDir,
        nginxPaths.sitesEnabledDir,
        nginxPaths.baseVhostPath,
      )
      .catch((err: Error): VerifyCheck => ({ name: 'nginx', pass: false, message: err.message })),
    adapters
      .checkCert(certPath)
      .catch((err: Error): VerifyCheck => ({ name: 'cert', pass: false, message: err.message })),
    adapters
      .checkGithubApp(githubApp.appId, githubApp.privateKey, githubApp.installationId)
      .catch(
        (err: Error): VerifyCheck => ({ name: 'github-app', pass: false, message: err.message }),
      ),
    adapters
      .checkRoute53(route53.accessKeyId, route53.secretAccessKey, route53.hostedZoneId)
      .catch((err: Error): VerifyCheck => ({ name: 'route53', pass: false, message: err.message })),
    adapters
      .checkWebhook()
      .catch((err: Error): VerifyCheck => ({ name: 'webhook', pass: false, message: err.message })),
  ]);

  const passing = results.filter((r) => r.pass).length;
  log(`verify: ${passing}/${results.length} checks green`);
  for (const r of results) {
    log(`verify: ${r.name} ${r.pass ? 'OK' : 'FAIL'} — ${r.message}`);
  }

  const remediations: RemediationCard[] = [];
  // `pendingRemediations` from attach-iam are surfaced first so the
  // operator's "Fix the next issue" cursor lands on them at the top.
  if (opts.pendingRemediations) remediations.push(...opts.pendingRemediations);
  for (const r of results) {
    if (!r.pass && REQUIRED_CHECKS.has(r.name)) {
      remediations.push(failureToCard(r));
    }
  }

  return {
    status: 'ok',
    message: `${passing}/${results.length} checks green`,
    remediations: remediations.length === 0 ? undefined : remediations,
  };
}
