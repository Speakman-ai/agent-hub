/**
 * Design chat handler — spawns a Claude Code CLI process whose cwd is a
 * design's artifact directory. Mirrors the room-chat flow structurally but
 * is much simpler: one singleton agent, no @mentions, no per-turn queueing.
 *
 * System prompt composition (see `buildDesignSystemPrompt`):
 *   1. The `design` skill body (singleton identity + rules)
 *   2. Linked-project design-system docs (DESIGN_SYSTEM.md, else SOUL.md)
 *   3. A snapshot of the files currently in the artifact dir
 *
 * After each assistant turn we persist the message, then broadcast both
 * `design_message_added` (chat pane) and `design_updated` (iframe reload).
 */
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { buildSpawnEnv } from './config.js';
import { appendDesignMessage, listDesignMessages, listDesignFiles } from './designs-store.js';
import type {
  Stmts,
  Project,
  AppConfig,
  BroadcastFn,
  DesignWithProjects,
  DesignMessageRow,
} from './types.js';

// ─── Dependency injection ────────────────────────────────────────────

interface DesignChatDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getClaudeBin: () => string;
  getDefaultModel: () => string;
  getConfig: () => AppConfig;
  /**
   * Designs are hub-level, so project IDs on the row may not resolve to a
   * real Project at send-time (project was deleted, or the user switched
   * orgs). We let callers inject the lookup they already own.
   */
  getDesign: (id: string) => DesignWithProjects | null;
  /** Absolute path of the `<dataDir>/designs/` directory. */
  getDesignsRoot: () => string;
  /**
   * Path to the default-skills directory so we can read the `design` skill
   * body at send-time without hard-coding the layout.
   */
  getDefaultSkillsDir: () => string;
}

interface DesignState {
  proc: ChildProcess | null;
  cancelled: boolean;
}

interface WebSocketLike {
  send: (data: string) => void;
}

interface DesignChatMsg {
  designId: string;
  content: string;
}

// ─── Module state ────────────────────────────────────────────────────

let deps: DesignChatDeps | null = null;

function getDeps(): DesignChatDeps {
  if (!deps) throw new Error('design-chat: initDesignChat() must be called before use');
  return deps;
}

export const activeDesignProcesses = new Map<string, DesignState>();

export function initDesignChat(d: DesignChatDeps): void {
  deps = d;
}

// ─── Cancel ──────────────────────────────────────────────────────────

export function handleDesignCancel(designId: string): void {
  const state = activeDesignProcesses.get(designId);
  if (!state) return;
  state.cancelled = true;
  if (state.proc) state.proc.kill('SIGTERM');
}

// ─── System prompt assembly ──────────────────────────────────────────

/**
 * Build the system prompt for a design session. Intentionally NOT reusing
 * `buildEnrichedPrompt` from chat.ts — that helper is rooted in the
 * project/agent model (IDENTITY.md, skills dir inside `ahw`, etc.) which
 * doesn't apply to a singleton design agent. We compose the minimal context
 * the agent actually needs here.
 */
export function buildDesignSystemPrompt(
  design: DesignWithProjects,
  opts: { designsRoot: string; defaultSkillsDir: string },
): string {
  const sections: string[] = [];

  // 1. The design skill itself.
  const skillPath = path.join(opts.defaultSkillsDir, 'design', 'SKILL.md');
  if (existsSync(skillPath)) {
    try {
      const raw = readFileSync(skillPath, 'utf-8');
      // Strip YAML frontmatter if present — the body is the instructional
      // content, frontmatter is metadata for the skill loader.
      const body = raw.replace(/^---[\s\S]*?---\s*/, '');
      sections.push(body.trim());
    } catch {
      // Skill file is best-effort — prompt still works without it.
    }
  }

  // 2. Each linked project's design-system doc (or SOUL.md fallback).
  for (const project of design.linkedProjects) {
    const docs = readProjectDesignDocs(project);
    if (docs) {
      sections.push(`\n## Design System — ${project.name}\n\n${docs}`);
    }
  }

  // 3. Snapshot of the artifact directory so the agent sees existing files.
  const files = listDesignFiles(opts.designsRoot, design.id);
  if (files.length > 0) {
    sections.push(`\n## Current files in this design\n\n${files.map((f) => `- ${f}`).join('\n')}`);
  } else {
    sections.push(`\n## Current files in this design\n\n(empty — seed \`index.html\` exists)`);
  }

  sections.push(
    `\n## Active design\n\n- id: ${design.id}\n- name: ${design.name}\n- cwd: your working directory is this design's artifact root`,
  );

  return sections.join('\n\n').trim();
}

function readProjectDesignDocs(project: Project): string | null {
  // Prefer an explicit DESIGN_SYSTEM.md; fall back to SOUL.md so every
  // linked project contributes *something* rather than silently dropping.
  const ahw = project.ahw;
  const candidates = [
    ahw ? path.join(ahw, 'DESIGN_SYSTEM.md') : null,
    ahw ? path.join(ahw, 'SOUL.md') : null,
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        return readFileSync(file, 'utf-8').trim();
      } catch {
        // fall through
      }
    }
  }
  return null;
}

// ─── Main handler ────────────────────────────────────────────────────

export async function handleDesignChat(
  ws: WebSocketLike | null,
  msg: DesignChatMsg,
): Promise<void> {
  const { designId, content } = msg;
  const d = getDeps();
  const { broadcast } = d;

  const design = d.getDesign(designId);
  if (!design) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown design: ${designId}` }));
    return;
  }

  if (!content || !content.trim()) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
    return;
  }

  // Reject concurrent turns — keep Phase 1 simple; queueing can come later.
  if (activeDesignProcesses.has(designId)) {
    if (ws)
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'Design is busy — wait for the current turn to finish.',
        }),
      );
    return;
  }

  // Persist + broadcast the user message first so the chat pane renders it
  // immediately, even before the CLI spawn completes.
  const userMsg = appendDesignMessage(designId, 'user', content);
  broadcast({ type: 'design_message_added', designId, message: userMsg });

  const state: DesignState = { proc: null, cancelled: false };
  activeDesignProcesses.set(designId, state);

  try {
    const CLAUDE_BIN = d.getClaudeBin();
    const DEFAULT_MODEL = d.getDefaultModel();
    const config = d.getConfig();
    const designsRoot = d.getDesignsRoot();
    const defaultSkillsDir = d.getDefaultSkillsDir();
    const designDir = path.join(designsRoot, designId);

    const systemPrompt = buildDesignSystemPrompt(design, { designsRoot, defaultSkillsDir });

    // Replay transcript so the agent has context of prior turns. Designs are
    // low-volume enough that we can ship the full history each turn; if this
    // gets expensive we can summarize.
    const history = listDesignMessages(designId) as DesignMessageRow[];
    const transcript = history
      .slice(0, -1) // exclude the user message we just appended — it becomes the prompt
      .map(
        (m) =>
          `[${m.role === 'assistant' ? 'Design Studio' : m.role === 'user' ? 'User' : 'System'}]: ${m.content}`,
      )
      .join('\n\n');
    const userPrompt = transcript
      ? `${transcript}\n\n[User]: ${content}\n\nRespond as Design Studio.`
      : content;

    broadcast({
      type: 'design_thinking',
      designId,
      messageId: userMsg.id,
    });

    let finalText = '';
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const args: string[] = [
          '--print',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          DEFAULT_MODEL,
          '--system-prompt',
          systemPrompt,
          userPrompt,
        ];

        let output = '';
        let errorOutput = '';
        const timeout = config.defaultTimeoutMs;
        const spawnEnv = buildSpawnEnv(config);

        const proc = spawn(CLAUDE_BIN, args, {
          cwd: designDir,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as ChildProcess;
        state.proc = proc;

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
        }, timeout);

        proc.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          broadcast({
            type: 'design_stream',
            designId,
            content: output,
          });
        });

        proc.stderr!.on('data', (chunk: Buffer) => {
          errorOutput += chunk.toString();
        });

        proc.on('close', (code: number | null) => {
          clearTimeout(timer);
          state.proc = null;
          if (state.cancelled) {
            reject(new Error('Cancelled'));
            return;
          }
          if (code !== 0 && !output) {
            reject(new Error(errorOutput || `Exited with code ${code}`));
          } else {
            resolve(output.trim() || errorOutput.trim() || '(empty response)');
          }
        });

        proc.on('error', (err: Error) => {
          clearTimeout(timer);
          state.proc = null;
          reject(err);
        });
      });

      finalText = result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (state.cancelled) {
        broadcast({ type: 'design_cancelled', designId });
      } else {
        broadcast({ type: 'design_error', designId, error: errMsg });
        // Persist the error as an assistant message so it shows up on reload.
        const assistantErr = appendDesignMessage(designId, 'assistant', `[error] ${errMsg}`);
        broadcast({ type: 'design_message_added', designId, message: assistantErr });
      }
      return;
    }

    // Persist the assistant turn, then tell the world about it: first the
    // chat pane (`design_message_added`), then the iframe (`design_updated`).
    const assistantMsg = appendDesignMessage(designId, 'assistant', finalText);

    broadcast({ type: 'design_message_added', designId, message: assistantMsg });
    broadcast({ type: 'design_updated', designId });
  } finally {
    activeDesignProcesses.delete(designId);
  }
}
