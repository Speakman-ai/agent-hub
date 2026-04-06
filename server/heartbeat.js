import cron from 'node-cron';
import { spawn } from 'child_process';
import { stmts } from './db.js';

const CLAUDE_BIN = '/home/ryan/.local/share/nvm/v22.22.0/bin/claude';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Track scheduled tasks so we can stop/restart them
const scheduledTasks = new Map();

/**
 * Run a claude --print command and return the result
 */
function runClaude(prompt, cwd, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--permission-mode', 'bypassPermissions'];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    args.push(prompt);

    let output = '';
    let errorOutput = '';
    const timeout = 5 * 60 * 1000; // 5 min timeout

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timed out after 5 minutes'));
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
    'no open pr', 'no failing', 'all clear', 'nothing to report',
    'no issues', 'everything looks good', 'no alerts', 'all checks pass',
    'no action needed', 'no stale', '0 open pull request',
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
 * Execute a heartbeat for an agent
 */
export async function runHeartbeat(agent) {
  if (!agent.heartbeat?.prompt) return null;

  console.log(`[Heartbeat] Running for ${agent.name}...`);
  const logEntry = stmts.addHeartbeatLog.run(agent.id, agent.heartbeat.prompt, 'running');
  const logId = logEntry.lastInsertRowid;

  try {
    const result = await runClaude(agent.heartbeat.prompt, agent.cwd, agent.systemPrompt);
    stmts.updateHeartbeatLog.run(result, 'success', logId);
    console.log(`[Heartbeat] ${agent.name} completed successfully`);

    await notifySlack(agent.name, result);
    return { id: logId, status: 'success', result };
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    stmts.updateHeartbeatLog.run(errorMsg, 'error', logId);
    console.error(`[Heartbeat] ${agent.name} failed:`, errorMsg);
    return { id: logId, status: 'error', result: errorMsg };
  }
}

/**
 * Execute a standalone cron job
 */
export async function runCronJob(cronJob) {
  console.log(`[Cron] Running "${cronJob.name}"...`);
  try {
    const result = await runClaude(cronJob.prompt, cronJob.cwd);
    stmts.updateCronResult.run(result, cronJob.id);
    console.log(`[Cron] "${cronJob.name}" completed successfully`);

    // Notify for cron results too
    if (SLACK_WEBHOOK_URL) {
      const lowerResult = result.toLowerCase();
      const allClear = ['no open', 'nothing to', 'all clear', 'no dependabot'].some(
        (p) => lowerResult.includes(p)
      );
      if (!allClear || result.length > 200) {
        await notifySlack(`Cron: ${cronJob.name}`, result);
      }
    }

    return { status: 'success', result };
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    stmts.updateCronResult.run(`ERROR: ${errorMsg}`, cronJob.id);
    console.error(`[Cron] "${cronJob.name}" failed:`, errorMsg);
    return { status: 'error', result: errorMsg };
  }
}

/**
 * Schedule all heartbeats and crons
 */
export function scheduleAll(agents) {
  // Clear existing schedules
  for (const [key, task] of scheduledTasks) {
    task.stop();
    scheduledTasks.delete(key);
  }

  // Schedule agent heartbeats
  for (const agent of agents) {
    if (agent.heartbeat?.enabled && agent.heartbeat?.interval) {
      if (!cron.validate(agent.heartbeat.interval)) {
        console.error(`[Heartbeat] Invalid cron expression for ${agent.name}: ${agent.heartbeat.interval}`);
        continue;
      }
      const task = cron.schedule(agent.heartbeat.interval, () => {
        runHeartbeat(agent);
      });
      scheduledTasks.set(`heartbeat:${agent.id}`, task);
      console.log(`[Heartbeat] Scheduled ${agent.name}: ${agent.heartbeat.interval}`);
    }
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
    }
  }

  console.log(`[Scheduler] ${scheduledTasks.size} tasks scheduled`);
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
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
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

  if (agent.heartbeat?.enabled && agent.heartbeat?.interval && cron.validate(agent.heartbeat.interval)) {
    const task = cron.schedule(agent.heartbeat.interval, () => {
      runHeartbeat(agent);
    });
    scheduledTasks.set(key, task);
    console.log(`[Heartbeat] Rescheduled ${agent.name}: ${agent.heartbeat.interval}`);
  }
}
