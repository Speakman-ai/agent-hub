/**
 * Start-time checks for a mainline (default branch + deploy) Autopilot run:
 * the deploy.yaml preflight and the one-session-per-environment guard.
 *
 * Nothing here writes. The start route re-runs the ownership guard inside the
 * transaction that persists the config, so two sessions starting at once
 * cannot both claim an environment.
 */
import type { Project } from './types.js';
import { parseAutopilotSessionConfig } from '../shared/utils/sessionAutopilot.js';
import { hostedRepoDefaultBranch } from './git-host/repo-store.js';
import { resolveDefaultBranch } from './git-default-branch.js';
import { readDeployYamlAtRef } from './deploy/deployment-checkout.js';
import { parseDeployConfig } from './deploy/deploy-config.js';
import { isEnvironmentDeployable } from './deploy/deployment-env-config-store.js';

export { autopilotMainlineStartEnabled } from './autopilot-mainline-availability.js';

export type MainlineTargetCheck =
  | { ok: true; defaultBranch: string; declaredEnvironments: string[] }
  | {
      ok: false;
      error:
        | 'autopilot_default_branch_unknown'
        | 'autopilot_deploy_config_missing'
        | 'autopilot_deploy_config_invalid'
        | 'autopilot_deploy_env_unknown'
        | 'autopilot_deploy_env_paused';
      message: string;
      declaredEnvironments: string[];
    };

export interface MainlineTargetDeps {
  /** Default branch as the session worktree sees it; preferred when present. */
  sessionDefaultBranch?: () => Promise<string | null>;
  hostedDefaultBranch?: (projectId: string) => Promise<string | null>;
  checkoutDefaultBranch?: (cwd: string) => Promise<string | null>;
  readDeployYaml?: (project: Project, ref: string) => Promise<string | null>;
  parseEnvironmentNames?: (raw: string) => string[];
  isDeployable?: (projectId: string, environment: string, declared: string[]) => boolean;
}

function formatDeclared(declared: string[]): string {
  return declared.length ? declared.map((e) => `"${e}"`).join(', ') : '(none)';
}

/**
 * Resolve the default branch and confirm its deploy.yaml declares
 * `environment` and the operator has not paused it.
 */
export async function checkMainlineAutopilotTarget(
  project: Project,
  environment: string,
  deps: MainlineTargetDeps = {},
): Promise<MainlineTargetCheck> {
  const env = environment.trim();
  const hosted = deps.hostedDefaultBranch ?? ((id: string) => hostedRepoDefaultBranch(id));
  const fromCheckout = deps.checkoutDefaultBranch ?? resolveDefaultBranch;

  let defaultBranch: string | null = null;
  try {
    defaultBranch = (await deps.sessionDefaultBranch?.()) ?? null;
    if (!defaultBranch && project.gitHost === 'agenthub') defaultBranch = await hosted(project.id);
    if (!defaultBranch && project.cwd) defaultBranch = await fromCheckout(project.cwd);
  } catch {
    defaultBranch = null;
  }
  if (!defaultBranch) {
    return {
      ok: false,
      error: 'autopilot_default_branch_unknown',
      message: 'Could not resolve the repository default branch for this project.',
      declaredEnvironments: [],
    };
  }

  const readYaml =
    deps.readDeployYaml ?? ((p: Project, ref: string) => readDeployYamlAtRef({ project: p, ref }));
  let raw: string | null;
  try {
    raw = await readYaml(project, defaultBranch);
  } catch (err) {
    return {
      ok: false,
      error: 'autopilot_deploy_config_invalid',
      message: `Could not read .agent-hub/deploy.yaml on '${defaultBranch}': ${err instanceof Error ? err.message : String(err)}`,
      declaredEnvironments: [],
    };
  }
  if (raw == null) {
    return {
      ok: false,
      error: 'autopilot_deploy_config_missing',
      message: `No .agent-hub/deploy.yaml on '${defaultBranch}'. Declare a deploy environment there before shipping to the default branch.`,
      declaredEnvironments: [],
    };
  }

  let declared: string[];
  try {
    const parseNames =
      deps.parseEnvironmentNames ??
      ((text: string) => [...parseDeployConfig(text).environments.keys()]);
    declared = parseNames(raw);
  } catch (err) {
    return {
      ok: false,
      error: 'autopilot_deploy_config_invalid',
      message: `.agent-hub/deploy.yaml on '${defaultBranch}' is invalid: ${err instanceof Error ? err.message : String(err)}`,
      declaredEnvironments: [],
    };
  }

  if (!declared.includes(env)) {
    return {
      ok: false,
      error: 'autopilot_deploy_env_unknown',
      message: `deploy.yaml on '${defaultBranch}' does not declare environment "${env}". Declared: ${formatDeclared(declared)}.`,
      declaredEnvironments: declared,
    };
  }

  const isDeployable = deps.isDeployable ?? isEnvironmentDeployable;
  if (!isDeployable(project.id, env, declared)) {
    return {
      ok: false,
      error: 'autopilot_deploy_env_paused',
      message: `Environment "${env}" is paused. Resume it on the Deployments page, or pick another: ${formatDeclared(declared)}.`,
      declaredEnvironments: declared,
    };
  }
  return { ok: true, defaultBranch, declaredEnvironments: declared };
}

export interface MainlineOwnerCandidate {
  id: string;
  agent_id: string;
  session_mode?: string | null;
  deleted_at?: string | null;
  autopilot_session_config?: string | null;
}

/**
 * The session that owns `projectId`/`environment`, if any besides
 * `excludeSessionId`. A mainline session owns its environment while its run is
 * live, and for as long as its slot owes a landing, whatever its run status,
 * mode, or archive state.
 */
export function findMainlineEnvironmentOwner(args: {
  candidates: MainlineOwnerCandidate[];
  projectOf: (agentId: string) => string | null;
  projectId: string;
  environment: string;
  excludeSessionId: string;
}): { sessionId: string; reason: 'running' | 'owes_landing' } | null {
  const env = args.environment.trim();
  for (const row of args.candidates) {
    if (row.id === args.excludeSessionId) continue;
    const cfg = parseAutopilotSessionConfig(row.autopilot_session_config);
    if (!cfg || cfg.target !== 'mainline' || !cfg.mainline) continue;
    if (cfg.mainline.deployEnvironment !== env) continue;
    if (args.projectOf(row.agent_id) !== args.projectId) continue;
    if (cfg.mainline.slot.phase !== 'idle') {
      return { sessionId: row.id, reason: 'owes_landing' };
    }
    const live =
      cfg.status === 'running' &&
      !!cfg.startedAt &&
      row.session_mode === 'autopilot' &&
      !row.deleted_at;
    if (live) return { sessionId: row.id, reason: 'running' };
  }
  return null;
}

/** Sessions whose stored Autopilot config may be mainline. */
export function listMainlineAutopilotCandidates(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): MainlineOwnerCandidate[] {
  return db
    .prepare(
      `SELECT id, agent_id, session_mode, deleted_at, autopilot_session_config
         FROM sessions
        WHERE autopilot_session_config LIKE '%mainline%'`,
    )
    .all() as MainlineOwnerCandidate[];
}
