import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { MAX_RESUME_ATTEMPTS, shouldGiveUpAutoResume } from './resume-attempts.js';
import {
  buildRestartResumeNotice,
  buildRestartResumePrompt,
  type KilledBackgroundShell,
} from './restart-resume-notice.js';
import type { ActiveTaskRow, SessionRow, Stmts } from './types.js';

export interface ResumeEntry {
  sessionId: string;
  agentId: string;
  content: string;
}

export interface OrphanedTaskDeps {
  stmts: Stmts;
  saveErrorMessage: (
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ) => string;
  listKilledShells: (sessionId: string) => KilledBackgroundShell[];
  isAutopilotSession: (sessionId: string) => boolean;
}

export function reconcileOrphanedTasks(deps: OrphanedTaskDeps): ResumeEntry[] {
  const { stmts, saveErrorMessage, listKilledShells } = deps;
  let orphans: ActiveTaskRow[] = [];
  try {
    orphans = stmts.getAllActiveTasks.all() as ActiveTaskRow[];
  } catch {
    return [];
  }
  if (orphans.length === 0) return [];
  console.log(`Reconciling ${orphans.length} orphaned task(s) from prior run`);

  const toResume: ResumeEntry[] = [];

  for (const t of orphans) {
    const partial = (t.streamed_output || '').trim();

    // Autopilot workers belong to their run controller, which fences and
    // reconciles them separately on boot. Never revive a paused/stopped worker
    // through ordinary chat recovery.
    if (deps.isAutopilotSession(t.session_id)) continue;

    // Epic/card membership is not a reason to create a replacement session.
    // Keep the card assigned and in its current lane so autonomous dispatch
    // cannot pick it up while this same session resumes below.
    const session = stmts.getSession.get(t.session_id) as SessionRow | undefined;
    if (!session) {
      console.log(`[Resume] Session ${t.session_id} no longer exists, skipping`);
      continue;
    }

    // Crash-loop guard: if this session has already been auto-resumed
    // MAX_RESUME_ATTEMPTS times without any turn completing cleanly, stop
    // re-spawning it and surface an error so a human can pick it up.
    //
    // We deliberately do NOT reset resume_attempts here — the cap must stay
    // durable. Giving up permanently stops the loop: this orphan's
    // active_tasks row is cleared by deleteAllActiveTasks below and we don't
    // re-spawn, so nothing re-creates a task for this session next boot.
    // Leaving the counter at the cap means that even if a later spawn is
    // itself interrupted before completing, we keep failing closed instead of
    // silently re-entering the loop with a fresh budget. The counter is reset
    // when a fresh externally initiated turn is committed to spawning in
    // handleChat. Automatic resumes and their continuations retain the cap.
    const priorAttempts = session.resume_attempts ?? 0;
    if (shouldGiveUpAutoResume(priorAttempts)) {
      const suffix = partial ? `\n\nPartial output before interruption:\n${partial}` : '';
      saveErrorMessage(
        t.session_id,
        t.message_id,
        t.engine,
        t.model ?? '',
        `Session repeatedly interrupted by server restarts (${priorAttempts}/${MAX_RESUME_ATTEMPTS} auto-resume attempts) and was not resumed again to avoid a crash loop. Send a message to continue.${suffix}`,
      );
      console.warn(
        `[Resume] Session ${t.session_id} hit MAX_RESUME_ATTEMPTS (${priorAttempts}/${MAX_RESUME_ATTEMPTS}); not auto-resuming`,
      );
      continue;
    }

    // The restart drained this session's CLI child by process *group*, so every
    // background job, dev server, test run and build it had started died too.
    // Both the transcript line and the resume prompt say so explicitly —
    // otherwise the resumed agent keeps polling work the Hub already killed.
    let killedShells: KilledBackgroundShell[] = [];
    try {
      killedShells = listKilledShells(t.session_id).map((row) => ({
        id: row.id,
        command: row.command,
        label: row.label,
      }));
    } catch (err) {
      console.warn(
        `[Resume] Failed to list killed background shells for ${t.session_id}:`,
        (err as Error).message,
      );
    }

    const infoMsgId: string = uuidv4();
    const infoText: string = buildRestartResumeNotice({ partial, killedShells });
    try {
      stmts.addMessage.run(
        infoMsgId,
        t.session_id,
        'assistant',
        infoText,
        t.engine,
        t.model,
        null,
        null,
        null,
        null,
        null,
      );
      stmts.touchSession.run(t.session_id);
    } catch (err) {
      console.error(
        `[Resume] Failed to save info message for session ${t.session_id}:`,
        (err as Error).message,
      );
    }

    const resumeContent: string = buildRestartResumePrompt({
      hasEngineSession: Boolean(session.engine_session_id),
      taskPrompt: t.prompt,
      killedShells,
    });

    // Record the attempt before re-spawning. Automatic resumes and their
    // continuations must retain this count across repeated restarts.
    try {
      stmts.incrementSessionResumeAttempts.run(t.session_id);
    } catch (err) {
      console.error(
        `[Resume] Failed to increment resume_attempts for session ${t.session_id}:`,
        (err as Error).message,
      );
    }

    toResume.push({
      sessionId: t.session_id,
      agentId: t.agent_id,
      content: resumeContent,
    });

    const worktreeGone: boolean = !!session.worktree_path && !existsSync(session.worktree_path);
    console.log(
      `[Resume] Will resume session ${t.session_id} (agent: ${t.agent_id}, hasEngineSession: ${!!session.engine_session_id}${worktreeGone ? ', worktree missing — cross-worktree resume' : ''})`,
    );
  }

  try {
    stmts.deleteAllActiveTasks.run();
  } catch {}

  return toResume;
}
