/**
 * Session-mode Autopilot — server helpers.
 *
 * Config parse/validate lives in shared/utils/sessionAutopilot.ts. Owns
 * the spawn preamble, post-push continue, and named-branch checkout.
 */
import { v4 as uuidv4 } from 'uuid';
import type { MessageRow, RouteDeps, SessionRow } from './types.js';
import { isAutopilotModeActive } from './session-mode.js';
import { checkoutAutopilotSessionBranch } from './worktree.js';
import { startSessionPreview } from './preview/start-session-preview.js';
import { casAutopilotConfig, stopAutopilotRun } from './session-autopilot-slot.js';
import { idleMainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';
import {
  type AutopilotSessionConfig,
  type AutopilotSetupInput,
  autopilotConfigFromSession,
  autopilotDeadlineReached,
  autopilotEscalationInstruction,
  autopilotStopNoticeContent,
  buildAutopilotKickoffMessage,
  buildAutopilotVerifyContinueMessage,
  deadlineAtFromDuration,
  isAutopilotRunning,
  parseAutopilotSessionConfig,
  serializeAutopilotSessionConfig,
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
  const escalationLine = autopilotEscalationInstruction(cfg.escalation);
  if (cfg.target === 'mainline' && cfg.mainline) {
    const env = cfg.mainline.deployEnvironment;
    return [
      '## Autopilot mode (default branch + deploy)',
      '',
      'You are running a Hub-owned implement → land → deploy → live-verify loop in this same session.',
      `- Every validated change goes live. Finalize validates your committed changes and pushes them to the default branch \`${cfg.branch}\`; the Hub then deploys environment \`${env}\`.`,
      '- Never `git checkout`, never create another branch, never push, merge, or open a PR yourself. Leave committable changes when a slice is ready; do not open a second session.',
      `- After each deploy the Hub reports the result here. Verify against the live \`${env}\` environment, not the session preview. If the deploy failed or verify finds a bug, fix it in the next slice.`,
      `- Brief: ${cfg.brief}`,
      `- Goal: ${cfg.goal}`,
      `- Duration: ${duration}`,
      `- ${escalationLine}`,
      '- When the goal holds, say so clearly and stop. When time is up, stop even if the goal is unmet.',
    ].join('\n');
  }
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
  return serializeAutopilotSessionConfig(cfg);
}

type AutopilotNoticeDeps = Pick<RouteDeps, 'stmts' | 'broadcast'>;

/**
 * Post a plain `role: 'system'` transcript line and broadcast it — without
 * calling handleChat, so announcing that Autopilot stopped never launches
 * another model turn.
 */
export function postAutopilotSystemNotice(
  deps: AutopilotNoticeDeps,
  sessionId: string,
  content: string,
): void {
  try {
    const msgId = uuidv4();
    deps.stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      content,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    const message =
      (deps.stmts.getMessageById?.get(msgId) as MessageRow | undefined) ??
      ({
        id: msgId,
        session_id: sessionId,
        role: 'system',
        content,
        engine: null,
        model: null,
        attachments: null,
        metadata: null,
        created_at: new Date().toISOString(),
      } as MessageRow);
    deps.broadcast({ type: 'message_added', sessionId, message });
  } catch (err) {
    console.warn(
      `[autopilot-session] failed to post stop notice session=${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Transcript notice for a mainline push. Posted without a model turn: the
 * next turn comes from the deploy result, not from the push.
 */
export function postAutopilotMainlinePushNotice(
  deps: AutopilotNoticeDeps,
  sessionId: string,
  args: {
    outcome: 'landed' | 'already_landed' | 'rejected' | 'unknown';
    sha: string;
    branch: string;
    detail?: string;
  },
): void {
  const short = args.sha.slice(0, 7);
  const content =
    args.outcome === 'landed'
      ? `Autopilot pushed ${short} to ${args.branch}. The deploy runs next.`
      : args.outcome === 'already_landed'
        ? `${short} was already on ${args.branch} from an earlier landing, so nothing new was pushed or deployed.`
        : args.outcome === 'rejected'
          ? `Autopilot could not push ${short} to ${args.branch}: the remote rejected it` +
            (args.detail ? ` (${args.detail})` : '') +
            '. Rebase and Finalize again.'
          : `Autopilot does not know whether ${short} reached ${args.branch}` +
            (args.detail ? ` (${args.detail})` : '') +
            '. It will check the remote before doing anything else.';
  postAutopilotSystemNotice(deps, sessionId, content);
}

/**
 * Deadline / stopped gate applied BEFORE any further automatic work or push.
 *
 * The post-push cycle bump is not enough on its own: a session that never
 * pushes (implementation or CI still running when the clock runs out) would
 * never expire, and an over-running turn could still trigger one more push.
 * Called at the top of the Finalize auto-start / auto-push paths.
 *
 * Returns `blocked: true` when the session must not do more automatic work —
 * either it already stopped, or the deadline just passed (in which case this
 * persists `expired` and posts the stop notice, no model turn).
 */
export function enforceAutopilotExpiry(args: { deps: AutopilotNoticeDeps; session: SessionRow }): {
  blocked: boolean;
} {
  const { deps, session } = args;
  if (!isAutopilotModeActive(session)) return { blocked: false };
  const cfg = autopilotConfigFromSession(session);
  if (!cfg || !cfg.startedAt) return { blocked: false };
  // Already stopped (expired/completed/paused/escalated): no more auto work.
  if (cfg.status !== 'running') return { blocked: true };
  if (!autopilotDeadlineReached(cfg)) return { blocked: false };
  // Decide again from the stored row: only the caller that moves it off
  // `running` posts the notice, so concurrent gates announce the stop once.
  const stopped = stopAutopilotRun({
    stmts: deps.stmts,
    sessionId: session.id,
    to: 'expired',
    when: (current) => autopilotDeadlineReached(current),
  });
  if (stopped.wrote && stopped.cfg) {
    postAutopilotSystemNotice(
      deps,
      session.id,
      autopilotStopNoticeContent(
        'expired',
        stopped.cfg.branch,
        stopped.cfg.target,
        stopped.cfg.mainline,
      ),
    );
    return { blocked: true };
  }
  // Someone else changed the row first; block unless it is still running.
  return { blocked: stopped.cfg?.status !== 'running' };
}

/**
 * A started config. For `mainline` the caller sets `branch` to the resolved
 * default branch before persisting.
 */
export function startAutopilotConfig(
  input: AutopilotSetupInput,
  nowIso: string = new Date().toISOString(),
): AutopilotSessionConfig {
  const { deployEnvironment, ...setup } = input;
  return {
    ...setup,
    startedAt: nowIso,
    deadlineAt: deadlineAtFromDuration(nowIso, input.durationHours),
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: input.target,
    mainline:
      input.target === 'mainline' && deployEnvironment
        ? {
            deployEnvironment,
            slot: idleMainlineSlot(nowIso),
            landedCount: 0,
          }
        : null,
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

  const bumped = casAutopilotConfig<AutopilotSessionConfig>(deps.stmts, session.id, (current) => {
    if (!isAutopilotRunning(current)) return { skip: current };
    const next: AutopilotSessionConfig = {
      ...current,
      cycle: current.cycle + 1,
      lastPushSha: sha,
    };
    if (autopilotDeadlineReached(next)) next.status = 'expired';
    return { write: next, result: next };
  });
  if (!bumped.wrote) {
    if (bumped.reason === 'conflict') {
      console.warn(`[autopilot-session] cycle bump lost the row race session=${session.id}`);
    }
    return;
  }
  const next = bumped.result;

  if (next.status !== 'running') {
    // Announce the stop as a plain transcript line — never via handleChat,
    // which would launch another model turn on an already-stopped session.
    postAutopilotSystemNotice(
      deps,
      session.id,
      autopilotStopNoticeContent(next.status, branch, next.target, next.mainline),
    );
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
