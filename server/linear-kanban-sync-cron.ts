import config, { buildSpawnEnv } from './config.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from './project-aws-spawn.js';
import { getOrgOwnerUserId } from './session-ownership.js';
import { resolveLinearApiKey } from './linear-skill-auth-resolve.js';
import type { ResolvedOneShotEngine } from './engine-resolver.js';
import type { CronRow, Project, Stmts } from './types.js';
import {
  LINEAR_KANBAN_SYNC_CRON_NAME,
  LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS,
  linearKanbanSyncConfigForCron,
} from './linear-kanban-sync-config.js';
import { runLinearKanbanSync } from './linear-kanban-sync.js';

export const LINEAR_KANBAN_SYNC_PROMPT =
  'Native linear-kanban-sync runner (server/linear-kanban-sync.ts). This prompt is ignored at runtime.';

/**
 * Dummy engine resolution for cron session rows — linear-kanban-sync does not
 * spawn a CLI; heartbeat still persists engine/model on the cron session.
 */
export function buildSyntheticResolvedForLinearSync(
  requestedModel: string | null,
): ResolvedOneShotEngine {
  return {
    engine: 'claude-code',
    model: requestedModel ?? config.engineDefaultModels['claude-code'] ?? 'claude-sonnet-4-6',
    fallbackUsed: false,
    availability: {
      'claude-code': { engine: 'claude-code', available: true },
      'cursor-agent': {
        engine: 'cursor-agent',
        available: false,
        reason: 'no-binary',
        detail: 'linear-kanban-sync does not spawn CLIs',
      },
      'gemini-cli': {
        engine: 'gemini-cli',
        available: false,
        reason: 'no-binary',
        detail: 'linear-kanban-sync does not spawn CLIs',
      },
      'codex-cli': {
        engine: 'codex-cli',
        available: false,
        reason: 'no-binary',
        detail: 'linear-kanban-sync does not spawn CLIs',
      },
    },
  };
}

/**
 * Ensures the surveytracker sync cron uses a 45-minute wall timeout instead of
 * the shared 15-minute default.
 */
export function ensureLinearKanbanSyncTimeout(stmts: Stmts, cronJob: CronRow): number {
  const desired = LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS;
  if (cronJob.timeout_ms === desired) return desired;
  if (cronJob.timeout_ms == null || cronJob.timeout_ms < desired) {
    stmts.updateCron.run(
      cronJob.name,
      cronJob.schedule,
      LINEAR_KANBAN_SYNC_PROMPT,
      cronJob.cwd,
      cronJob.enabled,
      cronJob.project_id,
      desired,
      cronJob.notify_on_run,
      cronJob.model,
      cronJob.skill_principal_agent_id,
      cronJob.engine,
      cronJob.id,
    );
    console.log(
      `[Cron] "${cronJob.name}": raised timeout_ms to ${desired} (${desired / 60_000} min)`,
    );
    return desired;
  }
  return cronJob.timeout_ms;
}

export function buildLinearKanbanSyncEnv(
  cronJob: CronRow,
  cronProject: Project | null,
  cronSkillAgentId: string | undefined,
): Record<string, string | undefined> {
  const cronOwnerId = getOrgOwnerUserId();
  const env = buildSpawnEnv(config, { userId: cronOwnerId }) as Record<string, string | undefined>;
  if (cronProject && cronSkillAgentId) {
    mergeSkillCredentialSpawnEnv(env as NodeJS.ProcessEnv, {
      ownerId: cronOwnerId,
      agentId: cronSkillAgentId,
      project: cronProject,
    });
    mergeProjectSecretsSpawnEnv(env as NodeJS.ProcessEnv, {
      projectId: cronProject.id,
      sessionId: null,
    });
    mergeProjectAwsSpawnEnv(env as NodeJS.ProcessEnv, cronProject);
  }
  return env;
}

/**
 * Runs the deterministic Linear ↔ kanban sync for the `linear-kanban-sync` cron.
 */
export async function executeLinearKanbanSyncCron(
  cronJob: CronRow,
  opts: {
    stmts: Stmts;
    /** Wall budget from `runCronJob` (cron row or default). */
    timeoutMs: number;
    cronProject: Project | null;
    cronSkillAgentId: string | undefined;
  },
): Promise<string> {
  const syncConfig = linearKanbanSyncConfigForCron(cronJob.project_id);
  if (!syncConfig) {
    throw new Error(
      `linear-kanban-sync: no sync config for project_id="${cronJob.project_id ?? 'null'}"`,
    );
  }

  const env = buildLinearKanbanSyncEnv(cronJob, opts.cronProject, opts.cronSkillAgentId);
  const { apiKey } = resolveLinearApiKey(env);
  if (!apiKey) {
    throw new Error(
      'LINEAR_API_KEY is not configured. Store it under Settings → Skills → Credentials → Linear.',
    );
  }

  const ensuredMs = ensureLinearKanbanSyncTimeout(opts.stmts, cronJob);
  const wallMs = Math.max(ensuredMs, opts.timeoutMs);
  const deadlineMs = Date.now() + wallMs;
  const log = (line: string) => console.log(line);

  const result = await runLinearKanbanSync({
    stmts: opts.stmts,
    dataDir: config.dataDir,
    apiKey,
    config: syncConfig,
    log,
    deadlineMs,
  });

  return result.summary;
}

export function isLinearKanbanSyncCron(cronJob: CronRow): boolean {
  return cronJob.name === LINEAR_KANBAN_SYNC_CRON_NAME;
}
