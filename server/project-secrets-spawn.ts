import { loadProjectEnvForSpawn } from './preview/preview-secrets-store.js';

/**
 * Merge per-project secrets into a spawn env. Values are decrypted only
 * here — list/GET APIs return MASK for `secret`-kind rows.
 *
 * Existing keys in `base` win (Hub-injected AGENT_HUB_* / credentials are
 * never overwritten). Reserved keys are rejected at write time.
 *
 * `opts.sessionId` is the chat session driving the spawn, used solely for
 * audit-log attribution on decryption failures (see the `TOOL_ERROR` line
 * in the catch block below). Pass the interactive session id for chat /
 * design / autonomous spawns. Pass `null` when no single owning session
 * exists — heartbeats and crons (scheduled, no session), and room/
 * conference spawns (multiple participating sessions, no single owner).
 * The audit entry then records `session: null` as the correct
 * attribution for "system-initiated decrypt", not as a placeholder for
 * a missing interactive value.
 */
export function mergeProjectSecretsSpawnEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    projectId: string;
    sessionId?: string | null;
    /**
     * When true, preview secrets replace keys already present in `base`.
     * Use for `docker compose` spawn env: Compose interpolates
     * `process.env` before `.env`, so stale host `AWS_*` must not beat
     * wizard-persisted values. CLI chat spawns keep the default (false) so
     * Hub-injected credentials are not clobbered.
     */
    overwriteExisting?: boolean;
  },
): void {
  try {
    const projectEnv = loadProjectEnvForSpawn(opts.projectId, {
      sessionId: opts.sessionId ?? null,
    });
    const overwrite = opts.overwriteExisting === true;
    for (const [key, value] of Object.entries(projectEnv)) {
      if (overwrite || base[key] === undefined) {
        base[key] = value;
      }
    }
  } catch (err) {
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    const meta = JSON.stringify({
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      session: opts.sessionId ?? null,
      tags: ['project-secrets', 'spawn'],
    });
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | project-secrets | spawn merge | error | ${summary} | ${meta}`,
    );
  }
}
