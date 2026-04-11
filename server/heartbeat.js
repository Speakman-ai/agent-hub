import cron from 'node-cron';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { db, stmts } from './db.js';
import config from './config.js';
import { getOrCreateProcessWorktree } from './worktree.js';

const CLAUDE_BIN = config.claudeBin;
const SLACK_WEBHOOK_URL = config.slackWebhookUrl;

// Track scheduled tasks so we can stop/restart them
const scheduledTasks = new Map();

// Track which agents have a heartbeat currently running (prevent double-launch)
const runningHeartbeats = new Set();

// Optional callback for babysit-complete events (set by index.js).
let onBabysitComplete = null;
export function setOnBabysitComplete(fn) {
  onBabysitComplete = fn;
}

// Optional callback for cron session updates (set by index.js).
let onCronSessionUpdate = null;
export function setOnCronSessionUpdate(fn) {
  onCronSessionUpdate = fn;
}

/**
 * Format a Date as an ISO string suitable for SQLite TEXT columns.
 * Returns null for invalid/missing dates.
 */
function isoOrNull(date) {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Persist a task's next-run time. Called after scheduling and after each execution.
 */
function persistNextRun(kind, id, task) {
  try {
    const next = isoOrNull(task.getNextRun?.());
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, next, null);
    } else if (kind === 'cron') {
      stmts.updateCronNextRun.run(next, id);
    }
  } catch (err) {
    console.error(`[Scheduler] Failed to persist next run for ${kind}:${id}:`, err.message);
  }
}

/**
 * Persist that a task ran at the given time.
 */
function persistLastRun(kind, id, when = new Date()) {
  const iso = isoOrNull(when);
  try {
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, null, iso);
    }
    // Crons already track last_run via updateCronResult.
  } catch (err) {
    console.error(`[Scheduler] Failed to persist last run for ${kind}:${id}:`, err.message);
  }
}

/**
 * Run a claude --print command and return the result
 * @param {string} prompt
 * @param {string} cwd
 * @param {string} [systemPrompt]
 * @param {{ timeoutMs?: number }} [options]
 */
export function runClaude(prompt, cwd, systemPrompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--permission-mode', 'bypassPermissions'];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    args.push(prompt);

    let output = '';
    let errorOutput = '';
    const timeout = options.timeoutMs || config.defaultTimeoutMs;

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !output) {
        reject(new Error(errorOutput || `Exited with code ${code}`));
      } else {
        resolve(output.trim() || errorOutput.trim() || '(empty response)');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send a notable result to Slack webhook
 */
async function notifySlack(agentName, result) {
  if (!SLACK_WEBHOOK_URL) return;

  // Skip "all clear" type responses
  const lowerResult = result.toLowerCase();
  const allClearPatterns = [
    'no open pr',
    'no failing',
    'all clear',
    'nothing to report',
    'no issues',
    'everything looks good',
    'no alerts',
    'all checks pass',
    'no action needed',
    'no stale',
    '0 open pull request',
  ];
  if (allClearPatterns.some((p) => lowerResult.includes(p)) && result.length < 200) {
    return;
  }

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🤖 *${agentName} Heartbeat*\n${result.substring(0, 2000)}`,
      }),
    });
  } catch (err) {
    console.error('Failed to send Slack notification:', err.message);
  }
}

/**
 * Send push notifications to all registered mobile devices via Expo's push API.
 */
async function sendPushNotifications(cronName, result, sessionId, cronId) {
  const tokens = stmts.getAllDeviceTokens.all();
  if (!tokens.length) return;

  const body = result.length > 200 ? result.slice(0, 200) + '...' : result;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: `Cron: ${cronName}`,
    body,
    data: { sessionId, cronId: String(cronId) },
  }));

  // Expo supports batches of 100
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const data = await resp.json();
      if (data.data) {
        data.data.forEach((receipt, idx) => {
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            stmts.removeDeviceToken.run(chunk[idx].to);
          }
        });
      }
    } catch (err) {
      console.error('[push] Failed to send:', err.message);
    }
  }
}

/**
 * Execute a heartbeat for an agent
 */
export async function runHeartbeat(agent) {
  if (!agent.heartbeat?.prompt) return null;

  // Prevent double-launch — skip if this agent already has a heartbeat running
  if (runningHeartbeats.has(agent.id)) {
    console.log(`[Heartbeat] Skipping ${agent.name} — already running`);
    return null;
  }
  runningHeartbeats.add(agent.id);

  console.log(`[Heartbeat] Running for ${agent.name}...`);
  persistLastRun('heartbeat', agent.id);
  const logEntry = stmts.addHeartbeatLog.run(agent.id, agent.heartbeat.prompt, 'running');
  const logId = logEntry.lastInsertRowid;

  try {
    const heartbeatCwd = getOrCreateProcessWorktree(agent.cwd, `heartbeat-${agent.id}`);
    // Docs agents do more work (read git log, check wiki, write pages) — give them more time
    const isDocsAgent = agent.role === 'docs';
    const timeoutMs =
      agent.heartbeat.timeoutMs || (isDocsAgent ? config.docsTimeoutMs : config.defaultTimeoutMs);
    const result = await runClaude(agent.heartbeat.prompt, heartbeatCwd, agent.systemPrompt, {
      timeoutMs,
    });
    stmts.updateHeartbeatLog.run(result, 'success', logId);
    console.log(`[Heartbeat] ${agent.name} completed successfully`);

    await notifySlack(agent.name, result);
    return { id: logId, status: 'success', result };
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    stmts.updateHeartbeatLog.run(errorMsg, 'error', logId);
    console.error(`[Heartbeat] ${agent.name} failed:`, errorMsg);
    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    runningHeartbeats.delete(agent.id);
    // Refresh next-run from the live task so the DB reflects the upcoming fire.
    const task = scheduledTasks.get(`heartbeat:${agent.id}`);
    if (task) persistNextRun('heartbeat', agent.id, task);
  }
}

/**
 * Execute a standalone cron job
 */
export async function runCronJob(cronJob) {
  console.log(`[Cron] Running "${cronJob.name}"...`);
  const logEntry = stmts.addCronLog.run(cronJob.id, 'running');
  const logId = logEntry.lastInsertRowid;
  const startTime = Date.now();

  // Babysit crons do real work (diagnose, fix, commit, push) — give them more time
  const isBabysit = cronJob.name.includes('[babysit]');
  const timeoutMs = isBabysit ? config.babysitTimeoutMs : config.defaultTimeoutMs;

  try {
    const cronCwd = getOrCreateProcessWorktree(cronJob.cwd, `cron-${cronJob.id}`);
    const result = await runClaude(cronJob.prompt, cronCwd, undefined, { timeoutMs });
    const durationMs = Date.now() - startTime;
    stmts.updateCronResult.run(result, cronJob.id);
    stmts.updateCronLog.run(result, 'success', durationMs, logId);
    console.log(`[Cron] "${cronJob.name}" completed successfully (${durationMs}ms)`);

    // ── Save result to a dedicated cron session ─────────────────
    try {
      let session = stmts.getSessionByCronId.get(cronJob.id);
      if (!session) {
        const sessionId = uuidv4();
        const sessionName = `Cron: ${cronJob.name}`;
        stmts.createSession.run(
          sessionId,
          '_cron',
          sessionName,
          'claude-code',
          'claude-opus-4-6',
          0,
        );
        stmts.updateSessionCronId.run(cronJob.id, sessionId);
        session = stmts.getSession.get(sessionId);
      }
      // Add the result as an assistant message
      const msgId = uuidv4();
      stmts.addMessage.run(msgId, session.id, 'assistant', result, 'claude-code', null, null);
      stmts.touchSession.run(session.id);

      // Send push notifications to registered mobile devices
      await sendPushNotifications(cronJob.name, result, session.id, cronJob.id);

      // Broadcast WebSocket event so clients can update their sidebar
      if (onCronSessionUpdate) {
        onCronSessionUpdate({
          type: 'cron_session_update',
          sessionId: session.id,
          cronId: cronJob.id,
          cronName: cronJob.name,
        });
      }
    } catch (err) {
      console.error(`[Cron] Failed to save session/push for "${cronJob.name}":`, err.message);
    }

    // ── Babysit auto-termination ────────────────────────────────
    // If this is a [babysit] cron and the agent reported completion,
    // delete the cron, stop its scheduler, and notify connected clients.
    if (cronJob.name.includes('[babysit]') && result.includes('BABYSIT_COMPLETE')) {
      console.log(`[Babysit] PR is green — deleting cron "${cronJob.name}" (id=${cronJob.id})`);
      try {
        // Stop the in-memory scheduled task first
        rescheduleCron({ ...cronJob, enabled: false });
        // Delete the cron row (cascade-deletes its logs)
        stmts.deleteCron.run(cronJob.id);
      } catch (err) {
        console.error(`[Babysit] Failed to clean up cron ${cronJob.id}:`, err.message);
      }

      // Extract PR info from cron name for the notification
      const prMatch = cronJob.name.match(/\[babysit\]\s+(.+?)\s+#(\d+)/);
      const prInfo = prMatch ? { repoSlug: prMatch[1], prNumber: parseInt(prMatch[2]) } : {};

      // Notify via Slack
      if (SLACK_WEBHOOK_URL) {
        await notifySlack(
          `Babysit Complete`,
          `PR ${prInfo.repoSlug || ''}#${prInfo.prNumber || '?'} is green and ready to merge.\n${result.substring(0, 500)}`,
        ).catch(() => {});
      }

      // Notify connected clients via callback
      if (onBabysitComplete) {
        onBabysitComplete({
          cronId: cronJob.id,
          cronName: cronJob.name,
          repoSlug: prInfo.repoSlug,
          prNumber: prInfo.prNumber,
          result: result.substring(0, 1000),
        });
      }
    }

    // Notify for cron results too
    if (SLACK_WEBHOOK_URL && !cronJob.name.includes('[babysit]')) {
      const lowerResult = result.toLowerCase();
      const allClear = ['no open', 'nothing to', 'all clear', 'no dependabot'].some((p) =>
        lowerResult.includes(p),
      );
      if (!allClear || result.length > 200) {
        await notifySlack(`Cron: ${cronJob.name}`, result);
      }
    }

    return { id: logId, status: 'success', result };
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    const durationMs = Date.now() - startTime;
    stmts.updateCronResult.run(`ERROR: ${errorMsg}`, cronJob.id);
    stmts.updateCronLog.run(errorMsg, 'error', durationMs, logId);
    console.error(`[Cron] "${cronJob.name}" failed:`, errorMsg);
    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    const task = scheduledTasks.get(`cron:${cronJob.id}`);
    if (task) persistNextRun('cron', cronJob.id, task);
    // Keep only the last 100 logs per cron
    try {
      stmts.pruneCronLogs.run(cronJob.id, cronJob.id);
    } catch {}
  }
}

/**
 * Schedule all heartbeats and crons.
 *
 * On boot, this also detects "missed" runs: if a task's previously persisted
 * next_run_at is in the past (because the server was offline when it was due),
 * it runs the task once immediately as a single catch-up. We do NOT replay
 * every missed slot — if you were off for a week, that would be a stampede.
 */
export function scheduleAll(agents) {
  // Clear existing schedules
  for (const [key, task] of scheduledTasks) {
    task.stop();
    scheduledTasks.delete(key);
  }

  // Clean up stale "running" heartbeat logs from previous server crashes/restarts.
  // These will never complete, so mark them as errors.
  try {
    const cleaned = db
      .prepare(
        `UPDATE heartbeat_logs SET status = 'error', result = 'Server restarted — run abandoned' WHERE status = 'running'`,
      )
      .run();
    if (cleaned.changes > 0) {
      console.log(
        `[Heartbeat] Cleaned up ${cleaned.changes} stale "running" log(s) from previous boot`,
      );
    }
  } catch (err) {
    console.error('[Heartbeat] Failed to clean stale logs:', err.message);
  }

  const now = Date.now();
  const missed = [];

  // Schedule agent heartbeats
  for (const agent of agents) {
    if (agent.heartbeat?.enabled && agent.heartbeat?.interval) {
      if (!cron.validate(agent.heartbeat.interval)) {
        console.error(
          `[Heartbeat] Invalid cron expression for ${agent.name}: ${agent.heartbeat.interval}`,
        );
        continue;
      }
      const task = cron.schedule(agent.heartbeat.interval, () => {
        runHeartbeat(agent);
      });
      scheduledTasks.set(`heartbeat:${agent.id}`, task);
      console.log(`[Heartbeat] Scheduled ${agent.name}: ${agent.heartbeat.interval}`);

      // Did we miss a previously-scheduled run while the server was down?
      const state = stmts.getHeartbeatState.get(agent.id);
      const prevNext = state?.next_run_at ? Date.parse(state.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Heartbeat] ${agent.name} missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => runHeartbeat(agent));
      }

      // Persist the upcoming run so next restart can detect missed runs again.
      persistNextRun('heartbeat', agent.id, task);
    } else {
      // Heartbeat disabled — clear any stale state.
      try {
        stmts.deleteHeartbeatState.run(agent.id);
      } catch {}
    }
  }

  // Clean up disabled babysit crons left over from previous runs.
  // These are ephemeral — once done, they should be deleted.
  try {
    const stale = stmts.getCrons.all().filter((c) => !c.enabled && c.name.includes('[babysit]'));
    for (const c of stale) {
      stmts.deleteCron.run(c.id);
      console.log(`[Babysit] Cleaned up stale disabled cron "${c.name}" (id=${c.id})`);
    }
  } catch (err) {
    console.error('[Babysit] Stale cleanup failed:', err.message);
  }

  // Schedule standalone crons
  const crons = stmts.getCrons.all();
  for (const cronJob of crons) {
    if (cronJob.enabled) {
      if (!cron.validate(cronJob.schedule)) {
        console.error(`[Cron] Invalid expression for "${cronJob.name}": ${cronJob.schedule}`);
        continue;
      }
      const task = cron.schedule(cronJob.schedule, () => {
        // Re-read from DB in case it was updated
        const fresh = stmts.getCron.get(cronJob.id);
        if (fresh && fresh.enabled) {
          runCronJob(fresh);
        }
      });
      scheduledTasks.set(`cron:${cronJob.id}`, task);
      console.log(`[Cron] Scheduled "${cronJob.name}": ${cronJob.schedule}`);

      // Catch up missed cron runs
      const prevNext = cronJob.next_run_at ? Date.parse(cronJob.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Cron] "${cronJob.name}" missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => {
          const fresh = stmts.getCron.get(cronJob.id);
          if (fresh && fresh.enabled) return runCronJob(fresh);
        });
      }

      persistNextRun('cron', cronJob.id, task);
    } else {
      // Disabled — clear any persisted next_run_at.
      try {
        stmts.updateCronNextRun.run(null, cronJob.id);
      } catch {}
    }
  }

  console.log(`[Scheduler] ${scheduledTasks.size} tasks scheduled`);

  // Fire catch-up runs after a short delay so the server has time to finish booting
  // (Slack bots, WS server, etc.) before we kick off potentially-long agent runs.
  if (missed.length > 0) {
    console.log(`[Scheduler] Replaying ${missed.length} missed run(s) in 5s...`);
    setTimeout(() => {
      for (const fn of missed) {
        try {
          fn();
        } catch (err) {
          console.error('[Scheduler] Catch-up run failed:', err.message);
        }
      }
    }, 5000);
  }
}

/**
 * Reschedule a single cron job (after update)
 */
export function rescheduleCron(cronJob) {
  const key = `cron:${cronJob.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (cronJob.enabled && cron.validate(cronJob.schedule)) {
    const task = cron.schedule(cronJob.schedule, () => {
      const fresh = stmts.getCron.get(cronJob.id);
      if (fresh && fresh.enabled) {
        runCronJob(fresh);
      }
    });
    scheduledTasks.set(key, task);
    persistNextRun('cron', cronJob.id, task);
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
  } else {
    // Disabled or invalid — clear next_run_at so we don't falsely catch up later.
    try {
      stmts.updateCronNextRun.run(null, cronJob.id);
    } catch {}
  }
}

/**
 * Reschedule heartbeat for an agent after config update
 */
export function rescheduleHeartbeat(agent) {
  const key = `heartbeat:${agent.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (
    agent.heartbeat?.enabled &&
    agent.heartbeat?.interval &&
    cron.validate(agent.heartbeat.interval)
  ) {
    const task = cron.schedule(agent.heartbeat.interval, () => {
      runHeartbeat(agent);
    });
    scheduledTasks.set(key, task);
    persistNextRun('heartbeat', agent.id, task);
    console.log(`[Heartbeat] Rescheduled ${agent.name}: ${agent.heartbeat.interval}`);
  } else {
    // Disabled — clear persisted state so it doesn't trigger a catch-up next boot.
    try {
      stmts.deleteHeartbeatState.run(agent.id);
    } catch {}
  }
}
