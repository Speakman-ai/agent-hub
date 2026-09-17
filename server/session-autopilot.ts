/**
 * Session-mode Autopilot — server helpers.
 *
 * Config parse/validate lives in shared/utils/sessionAutopilot.ts. This module
 * owns the spawn preamble, post-push continue, and named-branch checkout.
 */
import type { RouteDeps, SessionRow } from './types.js';
import { isAutopilotModeActive } from './session-mode.js';
import { checkoutAutopilotSessionBranch } from './worktree.js';
import { startSessionPreview } from './preview/start-session-preview.js';
import {
  type AutopilotSessionConfig,
  type AutopilotSetupInput,
  autopilotConfigFromSession,
  autopilotDeadlineReached,
  buildAutopilotKickoffMessage,
  buildAutopilotVerifyContinueMessage,
  deadlineAtFromDuration,
  isAutopilotRunning,
  parseAutopilotSessionConfig,
  validateAutopilotSetupInput,
} from '../shared/utils/sessionAutopilot.js';

export {
  autopilotConfigFromSession,
  parseAutopilotSessionConfig,
  validateAutopilotSetupInput,
  isAutopilotRunning,
  autopilotDeadlineReached,
};

export function buildAutopilotModePreamble(cfg: AutopilotSessionConfig | null): string {
  if (!cfg || !cfg.startedAt) {
    return [
      '## Autopilot mode',
      '',
      'This session is in Autopilot mode but has not been configured yet. Do not implement anything until the user submits the Autopilot startup card (duration, brief, goal, escalation, branch).',
    ].join('\n');
  }
  const duration =
    cfg.durationHours === 0
      ? 'no time limit'
      : `${cfg.durationHours} hours (deadline ${cfg.deadlineAt ?? 'unknown'})`;
  const escalationLine =
    cfg.escalation === 'none'
      ? 'Do not stop to ask the user unless the goal is met or time runs out.'
      : `Escalation is ${cfg.escalation}: pause and ask only when blocked or about to take a risky change.`;
  return [
    '## Autopilot mode',
    '',
    'You are running a Hub-owned implement → push → preview-verify loop in this same session.',
    `- Stay on branch \`${cfg.branch}\`. Never \`git checkout\`, never create another branch, never merge to main/master.`,
    `- Finalize will push this branch repeatedly. Leave committable changes when a slice is ready; do not open a second session.`,
    `- After each push, verify against **this session's preview** (preview tool: start if needed, then screenshot / read). Do not treat a production URL as the verify target.`,
    `- Brief: ${cfg.brief}`,
    `- Goal: ${cfg.goal}`,
    `- Duration: ${duration}`,
    `- ${escalationLine}`,
    '- When the goal holds, say so clearly and stop. When time is up, stop even if the goal is unmet.',
  ].join('\n');
}

export function serializeAutopilotConfig(cfg: AutopilotSessionConfig): string {
  return JSON.stringify(cfg);
}

export function startAutopilotConfig(
  input: AutopilotSetupInput,
  nowIso: string = new Date().toISOString(),
): AutopilotSessionConfig {
  return {
    ...input,
    startedAt: nowIso,
    deadlineAt: deadlineAtFromDuration(nowIso, input.durationHours),
    status: 'running',
    cycle: 0,
    lastPushSha: null,
  };
}

export async function bindAutopilotBranch(args: {
  session: SessionRow;
  branch: string;
  hostedBarePath?: string | null;
  persistBranch: (branch: string) => void;
}): Promise<{ ok: true; branch: string } | { ok: false; message: string }> {
  const { session, branch, hostedBarePath, persistBranch } = args;
  if (!session.worktree_path) {
    persistBranch(branch);
    return { ok: true, branch };
  }
  const result = await checkoutAutopilotSessionBranch(session, branch, hostedBarePath);
  if (result.kind === 'error') return { ok: false, message: result.message };
  persistBranch(result.branch);
  return { ok: true, branch: result.branch };
}

export function buildAutopilotStartUserMessage(cfg: AutopilotSessionConfig): string {
  return buildAutopilotKickoffMessage(cfg);
}

export function scheduleAutopilotAfterPush(args: {
  deps: Pick<RouteDeps, 'stmts' | 'handleChat' | 'broadcast' | 'findAgent' | 'getDevServerRuntime'>;
  session: SessionRow;
  sha: string;
  branch: string;
  prUrl?: string | null;
}): void {
  const { deps, session, sha, branch, prUrl } = args;
  if (!isAutopilotModeActive(session)) return;
  const cfg = autopilotConfigFromSession(session);
  if (!isAutopilotRunning(cfg) || !cfg) return;

  const next: AutopilotSessionConfig = {
    ...cfg,
    cycle: cfg.cycle + 1,
    lastPushSha: sha,
  };
  if (autopilotDeadlineReached(next)) {
    next.status = 'expired';
  }
  try {
    deps.stmts.updateSessionAutopilotConfig.run(serializeAutopilotConfig(next), session.id);
  } catch (err) {
    console.warn(
      `[autopilot-session] failed to persist cycle after push session=${session.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  if (next.status !== 'running') {
    void deps
      .handleChat(null, {
        type: 'chat',
        agentId: session.agent_id,
        sessionId: session.id,
        content: `Autopilot stopped: ${next.status === 'expired' ? 'time ran out' : next.status}. Branch \`${branch}\` is ready for a human to review and merge.`,
      })
      .catch((err: unknown) => {
        console.warn(
          `[autopilot-session] stop notice failed session=${session.id}:`,
          err instanceof Error ? err.message : err,
        );
      });
    return;
  }

  void (async () => {
    let previewNote: string | null = null;
    try {
      const preview = await startSessionPreview({
        sessionId: session.id,
        broadcast: deps.broadcast,
        findAgent: deps.findAgent,
        getSession: (id) => deps.stmts.getSession.get(id) as SessionRow | undefined,
        getDevServerRuntime: deps.getDevServerRuntime as never,
      });
      previewNote = preview.ok
        ? 'Hub started (or refreshed) this session’s preview. Use the preview tool to screenshot / read it.'
        : `Preview start returned: ${preview.error}. Use the preview tool to start it.`;
    } catch (err) {
      previewNote = `Preview start threw (${err instanceof Error ? err.message : String(err)}). Use the preview tool to start it.`;
    }
    await deps.handleChat(null, {
      type: 'chat',
      agentId: session.agent_id,
      sessionId: session.id,
      content: buildAutopilotVerifyContinueMessage({
        cfg: next,
        sha,
        branch,
        prUrl,
        previewNote,
      }),
    });
  })().catch((err: unknown) => {
    console.warn(
      `[autopilot-session] continue after push failed session=${session.id}:`,
      err instanceof Error ? err.message : err,
    );
  });
}
