import { loadProjectEnvForSpawn } from './preview/preview-secrets-store.js';

/**
 * Merge per-project secrets into a spawn env. Values are decrypted only
 * here — list/GET APIs return MASK for `secret`-kind rows.
 *
 * Existing keys in `base` win (Hub-injected AGENT_HUB_* / credentials are
 * never overwritten). Reserved keys are rejected at write time.
 */
export function mergeProjectSecretsSpawnEnv(
  base: NodeJS.ProcessEnv,
  opts: { projectId: string; sessionId?: string | null },
): void {
  try {
    const projectEnv = loadProjectEnvForSpawn(opts.projectId, {
      sessionId: opts.sessionId ?? null,
    });
    for (const [key, value] of Object.entries(projectEnv)) {
      if (base[key] === undefined) {
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
