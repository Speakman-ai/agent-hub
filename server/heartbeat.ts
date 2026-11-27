import cron, { type ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { existsSync } from 'fs';
import { db as _db, stmts as _stmts } from './db.js';
import config, { buildSpawnEnv } from './config.js';
import { resolveUserCliCredOverride } from './per-user-cli-spawn.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from './project-aws-spawn.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { runWorkspacePurge } from './session-purge.js';
import { reconcileMemoryFromWiki } from './memory.js';
import { maybeDispatchScheduledWikiBackfill, isWikiDocSkip } from './wiki-doc-session.js';
import { dispatchBackgroundAgentSession } from './background-agent-session.js';
import {
  finishBackgroundAgentRun,
  isBackgroundAgentRunning,
  startBackgroundAgentRun,
  type BackgroundAgentRun,
} from './background-agent-runs.js';
import { listPages, getPage } from './wiki.js';
import { getProjects } from './project-model.js';
import { initScheduledJobQueue } from './jobs/scheduled-jobs.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from './engine-resolver.js';
import { hostedBarePathForProject } from './git-host/repo-store.js';
import { runOneShotPromptWithFailover, formatFailoverSummary } from './one-shot-failover.js';
import { ALL_SUPPORTED_ENGINES, type SupportedEngine } from './engine-availability.js';
import type { EnrichedAgent, Project, BackgroundCustomAgentConfig } from './types.js';

const db = _db!;
const stmts = _stmts!;

const CLAUDE_BIN: string = config.claudeBin;

const scheduledTasks = new Map<string, ScheduledTask>();

function cronTimezone(timezone?: string | null): string {
  const candidate = timezone?.trim() || config.schedulerTimezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    console.warn(`[Scheduler] Invalid timezone "${candidate}" — falling back to UTC`);
    return 'UTC';
  }
}

interface RunClaudeOptions {
  timeoutMs?: number;
  detailed?: boolean;
  /**
   * Optional Claude model ID forwarded as `--model <id>`. When unset/empty
   * the CLI default is used. Callers validate it; no allowlist check
   * happens here so scheduled and manual runs stay agnostic to engine
   * catalog drift.
   */
  model?: string | null;
  /**
   * When set, merges decrypted per-user skill credentials into the spawn env
   * (same contract as interactive chat).
   */
  /**
   * Fully-resolved spawn env override. When set, runClaude uses it as the
   * child env verbatim instead of building one (callers that resolved
   * per-user CLI credentials themselves, e.g. via
   * `resolveSessionCliSpawnEnv`). `skillCredentialMerge` still applies.
   */
  spawnEnv?: NodeJS.ProcessEnv;
  skillCredentialMerge?: {
    ownerId: string | null;
    agentId: string;
    project: Project;
  };
}

interface DetailedResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options?: RunClaudeOptions & { detailed: true },
): Promise<DetailedResult>;
export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options?: RunClaudeOptions,
): Promise<string>;
export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options: RunClaudeOptions = {},
): Promise<string | DetailedResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cwd)) {
      return reject(
        new Error(`Working directory does not exist: "${cwd}" — update the cwd in agent settings`),
      );
    }

    const args: string[] = [
      '--print',
      '--permission-mode',
      claudePermissionModeForSpawn('bypassPermissions'),
    ];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    const modelOverride =
      typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null;
    if (modelOverride) {
      args.push('--model', modelOverride);
    }
    // see claude-cli-args.ts
    args.push(...disableNativeSkillToolArgs());
    // `--` terminates option parsing so the variadic `--disallowed-tools <tools...>`
    // doesn't swallow the trailing positional prompt (Claude CLI 2.x).
    args.push('--', prompt);

    let output = '';
    let errorOutput = '';
    const timeout = options.timeoutMs || config.defaultTimeoutMs;

    const heartbeatEnv =
      options.spawnEnv ??
      buildSpawnEnv(config, {
        userId: options.skillCredentialMerge?.ownerId ?? null,
        engine: 'claude-code',
      });
    if (options.skillCredentialMerge) {
      mergeSkillCredentialSpawnEnv(heartbeatEnv, options.skillCredentialMerge);
      // sessionId: null — heartbeats are scheduled, not driven by an
      // interactive chat session; decrypt-failure audit entries attribute to
      // system-initiated, not a missing value. See mergeProjectSecretsSpawnEnv.
      mergeProjectSecretsSpawnEnv(heartbeatEnv, {
        projectId: options.skillCredentialMerge.project.id,
        sessionId: null,
      });
      mergeProjectAwsSpawnEnv(heartbeatEnv, options.skillCredentialMerge.project, {
        ownerUserId: options.skillCredentialMerge?.ownerId ?? null,
      });
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: heartbeatEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timer = setTimeout(() => {
      console.info(
        `[heartbeat] heartbeat_wall_timeout: sending SIGTERM after ${timeout}ms cwd=${cwd}`,
      );
      killProcessGroup(proc, 'SIGTERM');
      if (options.detailed) {
        reject(
          Object.assign(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`), {
            stdout: output,
            stderr: errorOutput,
          }),
        );
      } else {
        reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
      }
    }, timeout);

    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (options.detailed) {
        resolve({
          stdout: output.trim(),
          stderr: errorOutput.trim(),
          code,
        });
      } else if (code !== 0 && !output) {
        reject(new Error(errorOutput || `Exited with code ${code}`));
      } else {
        resolve(output.trim() || errorOutput.trim() || '(empty response)');
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** True when scheduled work should run through the job queue (default). */
function scheduledJobsEnabled(): boolean {
  return config.scheduledJobsViaQueue !== false;
}

/**
 * Lazily construct + start the scheduled-work job queue. Idempotent. No-op
 * when the config flag is off. Per-agent heartbeats and project crons are
 * gone, so leftover `scheduled.heartbeat` / `scheduled.cron` jobs from an
 * older process are drained as no-ops and cannot spawn an agent.
 */
export function ensureScheduledJobQueue(): void {
  if (!scheduledJobsEnabled()) return;
  initScheduledJobQueue({
    db,
    concurrency: config.scheduledJobsConcurrency,
    heartbeatHandler: async (job) => {
      console.warn(`[Scheduler] Skipping leftover heartbeat job for agent ${job.payload.agentId}`);
    },
    cronHandler: async (job) => {
      console.warn(`[Scheduler] Skipping leftover cron job ${job.payload.cronId}`);
    },
  });
}

export function scheduleAll(_agents?: EnrichedAgent[]): void {
  ensureScheduledJobQueue();

  for (const [, task] of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.clear();

  try {
    const cleaned = db!
      .prepare(
        `UPDATE heartbeat_logs SET status = 'error', result = 'Abandoned — per-agent heartbeats are no longer scheduled' WHERE status = 'running'`,
      )
      .run();
    if (cleaned.changes > 0) {
      console.log(`[Scheduler] Abandoned ${cleaned.changes} leftover heartbeat log(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to abandon leftover heartbeat logs:', (err as Error).message);
  }

  try {
    const dropped = db!.prepare(`DELETE FROM heartbeat_state`).run();
    if (dropped.changes > 0) {
      console.log(`[Scheduler] Dropped ${dropped.changes} leftover heartbeat_state row(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to drop leftover heartbeat_state:', (err as Error).message);
  }

  // Workspace purge — hourly hard-delete of session rows past the 24-hour
  // archive window + stale-clone sweep across every project's workspace
  // dir. Hourly (not daily) so the effective worst-case disk retention
  // stays close to the 24h contract instead of drifting to ~48h. The tick
  // is cheap when there's nothing to do — `getExpiredArchivedSessions` is
  // an indexed scan, and `cleanupStaleWorkspaces` is a single readdir per
  // project — so the higher cadence has negligible overhead. Runs once at
  // startup (after a 30s grace so the scheduler isn't racing initial DB
  // writes / project hydration) and on the top of every hour. Wrapped in
  // `wrapCronTick` for the standard missed-run accounting and never throws
  // — `runWorkspacePurge` catches its own errors so a single bad row can't
  // kill the tick.
  const WORKSPACE_PURGE_SCHEDULE = '0 * * * *';
  const workspacePurgeTask = cron.schedule(
    WORKSPACE_PURGE_SCHEDULE,
    wrapCronTick(() => {
      // `runWorkspacePurge` is async (the stale-clone sweep now removes off the
      // event loop); catch the rejection so the tick never produces an
      // unhandled promise rejection.
      void runWorkspacePurge().catch((err: unknown) => {
        console.error('[Workspace Purge] Scheduled tick threw:', (err as Error).message);
      });
    }, 'system:workspace-purge'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(WORKSPACE_PURGE_SCHEDULE),
      name: 'system:workspace-purge',
    }),
  );
  scheduledTasks.set('system:workspace-purge', workspacePurgeTask);
  console.log(`[Scheduler] Workspace purge scheduled: ${WORKSPACE_PURGE_SCHEDULE}`);

  // One-shot startup pass so a freshly-restarted server reclaims any
  // backlog accumulated while it was down. Deferred 30s so the rest of
  // boot (project hydration, in-flight session resume, etc.) settles
  // first — the purge is read-write and we don't want it competing with
  // initial WAL pressure.
  setTimeout(() => {
    void runWorkspacePurge().catch((err: unknown) => {
      console.error('[Workspace Purge] Startup tick threw:', (err as Error).message);
    });
  }, 30_000);

  const WIKI_SYNC_SCHEDULE = '0 4 * * *';
  const wikiSyncTask = cron.schedule(
    WIKI_SYNC_SCHEDULE,
    wrapCronTick(
      () =>
        runWikiMemorySync().catch((err: unknown) => {
          console.error('[Wiki→Memory Sync] Scheduled run failed:', (err as Error).message);
        }),
      'system:wiki-memory-sync',
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(WIKI_SYNC_SCHEDULE),
      name: 'system:wiki-memory-sync',
    }),
  );
  scheduledTasks.set('system:wiki-memory-sync', wikiSyncTask);
  console.log(`[Scheduler] Wiki→Memory sync scheduled: ${WIKI_SYNC_SCHEDULE}`);

  // PR-env crons (cert-renewal, reaper, pool-alerts) were removed by
  // PR-Env Removal #4 along with the PR-env backing directory.

  scheduleBackgroundAgents();
  scheduleCustomBackgroundAgents();

  console.log(`[Scheduler] ${scheduledTasks.size} tasks scheduled`);
}

export async function runWikiMemorySync(): Promise<void> {
  const projects = getProjects();
  // Wiki→Memory sync now goes through the unified one-shot resolver so
  // it works whenever any engine is authed (Claude / Cursor / Codex /
  // Gemini), not just Claude Code. NoEnginesAvailableError surfaces as a
  // clear "skipping sync" log via reconcileMemoryFromWiki's catch block.
  // No human in-context for scheduled wiki→memory sync; strictly per-account
  // auth means the per-account engines are unavailable and only the
  // host-global Gemini can run this (else NoEnginesAvailableError is logged
  // by reconcileMemoryFromWiki). No org-owner fallback.
  const wikiSyncOwnerId: string | null = null;
  const opts = {
    cfg: config,
    spawnEnv: buildSpawnEnv(config, { userId: wikiSyncOwnerId }),
    spawnOwnerUserId: wikiSyncOwnerId,
  };

  for (const project of projects) {
    if (!project.ahw) continue;

    try {
      const pageMetas = listPages(project.id);
      if (!pageMetas.length) continue;

      const wikiPages = pageMetas
        .map((meta) => {
          const full = getPage(project.id, meta.slug);
          return {
            title: full?.title || meta.title,
            content: full?.content || '',
            category: full?.category || meta.category,
          };
        })
        .filter((p) => p.content.trim());

      if (!wikiPages.length) continue;

      console.log(
        `[Wiki→Memory Sync] Reconciling "${project.name}" (${wikiPages.length} wiki pages)...`,
      );
      await reconcileMemoryFromWiki(project.ahw, wikiPages, {
        ...opts,
        cwd: project.cwd,
      });
    } catch (err) {
      console.error(`[Wiki→Memory Sync] Failed for "${project.name}":`, (err as Error).message);
    }
  }
}

// Background agents (scheduled, project-scoped)
//
// Distinct from the removed project crons and per-agent heartbeats:
// background agents are built-in unattended jobs configured per project
// under `project.backgroundAgents`. The first
// kind is `wiki`, which dispatches the wiki documentation backfill on a
// cadence — otherwise the wiki is only refreshed on PR merge or via the
// operator-triggered backfill route.

/** Default cadence for the wiki background agent: daily at 03:00. */
export const DEFAULT_WIKI_BG_SCHEDULE = '0 3 * * *';

/** Scheduler task key for a project's wiki background agent. */
export function wikiBackgroundAgentKey(projectId: string): string {
  return `bg:wiki:${projectId}`;
}

/**
 * Fire the wiki background agent for a project: dispatch the wiki
 * documentation backfill as the configured owner. Never throws — logs the
 * outcome so a bad run can't kill the scheduler tick.
 */
export async function dispatchBackgroundWikiAgent(projectId: string): Promise<void> {
  try {
    const project = getProjects().find((p) => p.id === projectId);
    const wiki = project?.backgroundAgents?.wiki;
    if (!project || !wiki?.enabled) return;
    const outcome = maybeDispatchScheduledWikiBackfill({
      projectId,
      ownerUserId: wiki.ownerUserId ?? null,
      model: wiki.model ?? null,
      limit: wiki.limit,
    });
    if (isWikiDocSkip(outcome)) {
      console.log(
        `[Background Agent] wiki backfill skipped for "${project.name}": ${outcome.reason}`,
      );
    } else {
      console.log(
        `[Background Agent] wiki backfill ${outcome.reused ? 'reused' : 'started'} for "${project.name}" (session ${outcome.sessionId})`,
      );
    }
  } catch (err: unknown) {
    console.error(
      `[Background Agent] wiki dispatch threw for ${projectId}:`,
      (err as Error).message,
    );
  }
}

/**
 * Register a scheduler task per project whose wiki background agent is
 * enabled. Called from `scheduleAll` (which has already cleared the task
 * map) so tasks are keyed like the system tasks and torn down on the
 * next full reschedule.
 */
export function scheduleBackgroundAgents(): void {
  let count = 0;
  for (const project of getProjects()) {
    const wiki = project.backgroundAgents?.wiki;
    if (!wiki?.enabled) continue;
    const schedule = wiki.schedule?.trim() || DEFAULT_WIKI_BG_SCHEDULE;
    if (!cron.validate(schedule)) {
      console.error(`[Background Agent] Invalid wiki schedule for "${project.name}": ${schedule}`);
      continue;
    }
    const key = wikiBackgroundAgentKey(project.id);
    const task = cron.schedule(
      schedule,
      wrapCronTick(() => dispatchBackgroundWikiAgent(project.id), key),
      defaultTickOptions({
        intervalSeconds: estimateIntervalSeconds(schedule),
        name: key,
        timezone: cronTimezone(wiki.timezone),
      }),
    );
    scheduledTasks.set(key, task);
    count++;
    console.log(`[Background Agent] Scheduled wiki for "${project.name}": ${schedule}`);
  }
  if (count > 0) console.log(`[Background Agent] ${count} wiki agent(s) scheduled`);
}

/**
 * Reschedule a single project's wiki background agent after its config
 * changes (settings PATCH), without a full `scheduleAll` sweep. Stops any
 * existing task, then re-registers when enabled with a valid schedule.
 */
export function rescheduleBackgroundWikiAgent(project: Project): void {
  const key = wikiBackgroundAgentKey(project.id);
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }
  const wiki = project.backgroundAgents?.wiki;
  if (!wiki?.enabled) return;
  const schedule = wiki.schedule?.trim() || DEFAULT_WIKI_BG_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[Background Agent] Invalid wiki schedule for "${project.name}": ${schedule}`);
    return;
  }
  const task = cron.schedule(
    schedule,
    wrapCronTick(() => dispatchBackgroundWikiAgent(project.id), key),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(schedule),
      name: key,
      timezone: cronTimezone(wiki.timezone),
    }),
  );
  scheduledTasks.set(key, task);
  console.log(`[Background Agent] Rescheduled wiki for "${project.name}": ${schedule}`);
}

/** Scheduler task key for one custom background agent. */
export function customBackgroundAgentKey(projectId: string, agentId: string): string {
  return `bg:custom:${projectId}:${agentId}`;
}

/** Key prefix shared by all of a project's custom background agent tasks. */
function customBackgroundAgentKeyPrefix(projectId: string): string {
  return `bg:custom:${projectId}:`;
}

/** Coerce a stored engine override to a SupportedEngine, defaulting sanely. */
function coerceBackgroundEngine(raw: string | null | undefined): SupportedEngine {
  if (raw && (ALL_SUPPORTED_ENGINES as readonly string[]).includes(raw)) {
    return raw as SupportedEngine;
  }
  return 'claude-code';
}

/** The custom agents on a project that are enabled and have a runnable prompt. */
function runnableCustomAgents(project: Project): BackgroundCustomAgentConfig[] {
  const list = project.backgroundAgents?.custom;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (a): a is BackgroundCustomAgentConfig =>
      !!a && typeof a.id === 'string' && !!a.enabled && !!a.prompt && a.prompt.trim().length > 0,
  );
}

/** Outcome of a single custom-agent dispatch, for the manual test-run route. */
export type CustomAgentDispatchResult =
  | { status: 'skipped'; reason: 'no_project' | 'no_agent' | 'disabled' | 'no_prompt' | 'busy' }
  | { status: 'session'; sessionId: string; agentId: string; skippedSkills: string[] }
  | { status: 'completed'; ok: boolean }
  | { status: 'failed'; error: string };

/**
 * Fire one custom background agent. Scheduled ticks only run enabled agents;
 * a manual test run (`force`) runs the saved config regardless of the toggle.
 * With `runAsSession` the prompt opens a real chat session; otherwise it runs
 * as the configured owner through the shared one-shot failover runner.
 * Never throws so a bad run can't kill the scheduler tick.
 */
export async function dispatchBackgroundCustomAgent(
  projectId: string,
  agentId: string,
  opts: { force?: boolean; trigger?: 'manual' | 'schedule' } = {},
): Promise<CustomAgentDispatchResult> {
  let run: BackgroundAgentRun | null = null;
  try {
    const project = getProjects().find((p) => p.id === projectId);
    if (!project) return { status: 'skipped', reason: 'no_project' };
    const agent = (project.backgroundAgents?.custom ?? []).find((a) => a && a.id === agentId);
    if (!agent) return { status: 'skipped', reason: 'no_agent' };
    if (!agent.enabled && !opts.force) return { status: 'skipped', reason: 'disabled' };
    if (!agent.prompt || !agent.prompt.trim()) return { status: 'skipped', reason: 'no_prompt' };
    if (isBackgroundAgentRunning(projectId, agentId)) return { status: 'skipped', reason: 'busy' };

    run = startBackgroundAgentRun(projectId, agentId, opts.trigger ?? 'schedule');

    if (agent.runAsSession) {
      const sessionRun = run;
      // Filled in before the kickoff can reject: handleChat always settles
      // asynchronously, after dispatch has returned.
      let link: { sessionId: string | null; sessionAgentId: string | null } = {
        sessionId: null,
        sessionAgentId: null,
      };
      const started = dispatchBackgroundAgentSession(project, agent, {
        onKickoffError: (message) =>
          finishBackgroundAgentRun(sessionRun, {
            ok: false,
            error: `Session failed to start: ${message}`,
            ...link,
          }),
      });
      link = { sessionId: started.sessionId, sessionAgentId: started.agentId };
      finishBackgroundAgentRun(run, {
        ok: true,
        ...link,
        error:
          started.skippedSkills.length > 0
            ? `Skills not loaded: ${started.skippedSkills.join(', ')}`
            : null,
      });
      console.log(
        `[Background Agent] custom "${agent.name}" opened session ${started.sessionId} for "${project.name}"`,
      );
      return { status: 'session', ...started };
    }

    const ownerUserId: string | null = agent.ownerUserId ?? null;
    const cwd = await getOrCreateProcessWorktree(
      project.cwd,
      `bg-custom-${agentId}`,
      undefined,
      undefined,
      project.repoUrl ?? null,
      project.id,
      project.githubRepo ?? null,
      hostedBarePathForProject(project),
    );

    const preferred = coerceBackgroundEngine(agent.engine);
    const resolved = await resolveOneShotEngine(config, {
      preferred,
      preferredModel: agent.model ?? null,
      userId: ownerUserId,
      agentId: null,
    });

    const buildEnv = (engine: SupportedEngine): NodeJS.ProcessEnv => {
      const env = buildSpawnEnv(config, {
        userId: ownerUserId,
        userOverride: resolveUserCliCredOverride(ownerUserId),
        engine,
      });
      mergeProjectSecretsSpawnEnv(env, { projectId: project.id, sessionId: null });
      mergeProjectAwsSpawnEnv(env, project, { ownerUserId: ownerUserId ?? null });
      return env;
    };

    const outcome = await runOneShotPromptWithFailover(
      {
        scope: `background agent "${agent.name}"`,
        engine: resolved.engine,
        model: resolved.model,
        userId: ownerUserId,
        agentId: null,
        prompt: agent.prompt,
        cwd,
        timeoutMs: config.defaultTimeoutMs,
        buildEnv,
        detailed: true,
      },
      config,
    );
    const detailed = outcome.detailed;
    const ok = detailed.code === 0 && !detailed.timedOut;
    finishBackgroundAgentRun(run, {
      ok,
      output: outcome.output,
      error: ok
        ? null
        : detailed.timedOut
          ? 'Timed out'
          : (detailed.stderr || '').trim().slice(-2000) || `Exited with code ${detailed.code}`,
    });
    console.log(
      `[Background Agent] custom "${agent.name}" ran for "${project.name}" via ${outcome.engine}` +
        formatFailoverSummary(outcome.failovers),
    );
    return { status: 'completed', ok };
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    if (run) finishBackgroundAgentRun(run, { ok: false, error: message });
    console.error(`[Background Agent] custom dispatch threw for ${projectId}/${agentId}:`, message);
    return { status: 'failed', error: message };
  }
}

/** Register scheduler tasks for every enabled custom agent across all projects. */
export function scheduleCustomBackgroundAgents(): void {
  let count = 0;
  for (const project of getProjects()) {
    for (const agent of runnableCustomAgents(project)) {
      const schedule = agent.schedule?.trim() || DEFAULT_WIKI_BG_SCHEDULE;
      if (!cron.validate(schedule)) {
        console.error(
          `[Background Agent] Invalid schedule for custom "${agent.name}" in "${project.name}": ${schedule}`,
        );
        continue;
      }
      const key = customBackgroundAgentKey(project.id, agent.id);
      const task = cron.schedule(
        schedule,
        wrapCronTick(
          () => dispatchBackgroundCustomAgent(project.id, agent.id).then(() => undefined),
          key,
        ),
        defaultTickOptions({
          intervalSeconds: estimateIntervalSeconds(schedule),
          name: key,
          timezone: cronTimezone(agent.timezone),
        }),
      );
      scheduledTasks.set(key, task);
      count++;
      console.log(
        `[Background Agent] Scheduled custom "${agent.name}" for "${project.name}": ${schedule}`,
      );
    }
  }
  if (count > 0) console.log(`[Background Agent] ${count} custom agent(s) scheduled`);
}

/**
 * Reschedule all of a single project's custom background agents after a
 * settings PATCH: tear down every existing `bg:custom:<project>:*` task
 * (so removed/disabled agents stop) and re-register the enabled ones.
 */
export function rescheduleBackgroundCustomAgents(project: Project): void {
  const prefix = customBackgroundAgentKeyPrefix(project.id);
  for (const [key, task] of Array.from(scheduledTasks.entries())) {
    if (key.startsWith(prefix)) {
      task.stop();
      scheduledTasks.delete(key);
    }
  }
  for (const agent of runnableCustomAgents(project)) {
    const schedule = agent.schedule?.trim() || DEFAULT_WIKI_BG_SCHEDULE;
    if (!cron.validate(schedule)) {
      console.error(
        `[Background Agent] Invalid schedule for custom "${agent.name}" in "${project.name}": ${schedule}`,
      );
      continue;
    }
    const key = customBackgroundAgentKey(project.id, agent.id);
    const task = cron.schedule(
      schedule,
      wrapCronTick(
        () => dispatchBackgroundCustomAgent(project.id, agent.id).then(() => undefined),
        key,
      ),
      defaultTickOptions({
        intervalSeconds: estimateIntervalSeconds(schedule),
        name: key,
        timezone: cronTimezone(agent.timezone),
      }),
    );
    scheduledTasks.set(key, task);
  }
}

/**
 * Reschedule every background agent kind (wiki + custom) for a project after a
 * settings PATCH. Single entry point the projects route calls.
 */
export function rescheduleProjectBackgroundAgents(project: Project): void {
  rescheduleBackgroundWikiAgent(project);
  rescheduleBackgroundCustomAgents(project);
}

/**
 * Drop leftover heartbeat_state for a deleted agent. Heartbeats are no longer
 * scheduled; this stays so hard-delete (`DELETE /api/agents/:id`) can still
 * clean historical rows. Safe to call when no row exists.
 */
export function unscheduleHeartbeat(agentId: string): void {
  const key = `heartbeat:${agentId}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    try {
      existing.stop();
    } catch {
      // best-effort — node-cron may already be torn down during shutdown
    }
    scheduledTasks.delete(key);
  }
  try {
    stmts.deleteHeartbeatState.run(agentId);
  } catch {
    // best-effort — DB may be closed during shutdown
  }
}

/** In-memory scheduled task keys. Exported for tests. */
export function scheduledTaskKeys(): string[] {
  return [...scheduledTasks.keys()];
}
