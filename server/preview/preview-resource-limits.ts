/**
 * preview-resource-limits.ts — CPU/memory isolation for session dev-preview
 * compose stacks so they can't starve the control-plane Hub.
 *
 * Background: preview stacks run heavy dev servers (`ng serve`, `esbuild`,
 * `vite`, framework backends, postgres). Unbounded, several concurrent stacks
 * CPU-starved the single-threaded Hub process — its own health checks timed out
 * (>12s) while it sat at ~13% CPU, and nginx returned 502s. `renice` is only a
 * soft priority hint; the real fix is cgroup isolation.
 *
 * After `docker compose up` creates the stack's containers we `docker update`
 * each one with:
 *   - `--cpuset-cpus` confining previews to the NON-reserved cores, so the first
 *     N cores stay always-available for the Hub (it can't be starved).
 *   - `--cpus` a per-container ceiling so no single dev server dominates.
 *   - `--memory` (opt-in) so a runaway build can't OOM the box.
 *
 * Doing it post-`up` via `docker update` (rather than editing the project's
 * compose file) keeps it universal — it works regardless of how the project
 * authored its compose services, and is exactly the live mitigation applied
 * during the incident. All knobs are env-overridable; the cpuset auto-computes
 * from the host core count so a small self-host box degrades gracefully.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileP = promisify(execFile);

export interface PreviewLimits {
  /** Per-container CPU ceiling (cores). 0 disables the cap. */
  cpus: number;
  /** Per-container memory ceiling (docker suffix, e.g. "4g"), or null to skip. */
  memory: string | null;
  /** Cores previews are confined to (e.g. "2-7"), or null to skip pinning. */
  cpuset: string | null;
}

/**
 * Reserve the first `reserve` cores for the control plane; previews get the
 * rest. Returns null when there aren't enough cores to leave previews at least
 * two of their own (below that, pinning is counterproductive — fall back to the
 * `--cpus` cap alone).
 */
export function computePreviewCpuset(coreCount: number, reserve: number): string | null {
  if (!Number.isFinite(coreCount) || !Number.isFinite(reserve)) return null;
  if (reserve < 1) return null;
  // Need at least `reserve` reserved + 2 preview cores to bother pinning.
  if (coreCount < reserve + 2) return null;
  return `${reserve}-${coreCount - 1}`;
}

/** Resolve the effective limits from env + host core count. */
export function resolvePreviewLimits(
  env: NodeJS.ProcessEnv = process.env,
  coreCount: number = os.cpus().length,
): PreviewLimits {
  const cpus = Number(env.AGENT_HUB_PREVIEW_CPU_LIMIT ?? '2');
  const memRaw = (env.AGENT_HUB_PREVIEW_MEM_LIMIT ?? '').trim();
  const reserve = Math.max(
    1,
    Math.floor(Number(env.AGENT_HUB_PREVIEW_HOST_RESERVED_CORES ?? '2')) || 2,
  );
  const cpusetEnv = env.AGENT_HUB_PREVIEW_CPUSET?.trim();
  return {
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 2,
    memory: memRaw || null, // off by default — avoids OOM-killing a legit preview
    cpuset: cpusetEnv ? cpusetEnv : computePreviewCpuset(coreCount, reserve),
  };
}

/** Build the `docker update ... <id>` argv for one container. */
export function buildUpdateArgs(limits: PreviewLimits, containerId: string): string[] {
  const args = ['update'];
  if (limits.cpus > 0) args.push('--cpus', String(limits.cpus));
  if (limits.memory) args.push('--memory', limits.memory, '--memory-swap', limits.memory);
  if (limits.cpuset) args.push('--cpuset-cpus', limits.cpuset);
  args.push(containerId);
  return args;
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface ApplyPreviewLimitsOpts {
  composeProjectName: string;
  env?: NodeJS.ProcessEnv;
  coreCount?: number;
  /** Injectable for tests; defaults to real `execFile`. */
  exec?: ExecFn;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

/**
 * Apply CPU/memory caps to every container in a compose project. Best-effort:
 * a missing docker, a container that vanished, or a single failed update is
 * logged and skipped — it never throws (a failed cap must not fail the preview).
 * No-op when `AGENT_HUB_DISABLE_PREVIEW_LIMITS=1` (set in tests).
 */
export async function applyPreviewResourceLimits(
  opts: ApplyPreviewLimitsOpts,
): Promise<{ updated: number; total: number }> {
  const env = opts.env ?? process.env;
  if (env.AGENT_HUB_DISABLE_PREVIEW_LIMITS === '1') return { updated: 0, total: 0 };
  const exec = opts.exec ?? ((c, a) => execFileP(c, a));
  const limits = resolvePreviewLimits(env, opts.coreCount ?? os.cpus().length);
  if (limits.cpus <= 0 && !limits.memory && !limits.cpuset) return { updated: 0, total: 0 };

  let ids: string[];
  try {
    const { stdout } = await exec('docker', [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${opts.composeProjectName}`,
      '-q',
    ]);
    ids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    opts.logger?.warn(
      `[preview-limits] could not list containers for ${opts.composeProjectName}: ${(err as Error).message}`,
    );
    return { updated: 0, total: 0 };
  }

  let updated = 0;
  for (const id of ids) {
    try {
      await exec('docker', buildUpdateArgs(limits, id));
      updated++;
    } catch (err) {
      opts.logger?.warn(`[preview-limits] update ${id} failed: ${(err as Error).message}`);
    }
  }
  if (updated > 0) {
    opts.logger?.log(
      `[preview-limits] capped ${updated}/${ids.length} container(s) for ${opts.composeProjectName} ` +
        `(cpus=${limits.cpus}, mem=${limits.memory ?? 'none'}, cpuset=${limits.cpuset ?? 'none'})`,
    );
  }
  return { updated, total: ids.length };
}
