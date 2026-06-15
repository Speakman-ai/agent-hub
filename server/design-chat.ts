/**
 * Design chat handler — spawns the configured CLI (Claude Code, Cursor Agent,
 * Gemini CLI, or Codex) with cwd set to a design's artifact directory.
 * Mirrors the main chat flow at a high level (stream-json + parser) but stays
 * single-threaded: one turn at a time, no delegation.
 *
 * System prompt composition (see `buildDesignSystemPrompt`):
 *   1. The `design` skill body (singleton identity + rules)
 *   2. Linked-project design-system docs (DESIGN_SYSTEM.md, else SOUL.md)
 *   3. A snapshot of the files currently in the artifact dir
 *
 * After each assistant turn we persist the message, then broadcast both
 * `design_message_added` (chat pane) and `design_updated` (iframe reload).
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import {
  mergeProjectAwsSpawnEnv,
  projectHasAwsSsoProfiles,
  linkAwsSsoHostCacheIntoSpawnHome,
} from './project-aws-spawn.js';
import { DESIGN_SKILL_PRINCIPAL_AGENT_ID } from './design-skill-principal.js';
import { getWsAuthUserId, type AuthStampedWs } from './session-ownership.js';
import { appendDesignMessage, listDesignMessages, listDesignFiles } from './designs-store.js';
import { createStreamParser } from './stream-parser.js';
import { pickProcessErrorMessage } from './process-error-message.js';
import {
  applyAssistantTextChunkForDelegationKickoff,
  accumulateAssistantStreamForDelegateKickoff,
} from './delegation-kickoff-buffer.js';
import {
  normalizeDesignEngine,
  resolveDesignModelForEngine,
  buildDesignSpawnArgs,
} from './design-multi-engine.js';
import type {
  Stmts,
  Project,
  AppConfig,
  BroadcastFn,
  DesignWithProjects,
  DesignMessageRow,
  StreamEvent,
} from './types.js';

export { resolveDesignStudioModel } from './design-multi-engine.js';

// ─── Dependency injection ────────────────────────────────────────────

interface DesignChatDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  getGrokBin: () => string;
  getConfig: () => AppConfig;
  getDesign: (id: string) => DesignWithProjects | null;
  getDesignsRoot: () => string;
  getDefaultSkillsDir: () => string;
}

interface DesignState {
  proc: ChildProcess | null;
  cancelled: boolean;
  messageId: string | null;
  lastStream: string;
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

// `create-chat` writes the new chat id under `$HOME/.cursor`. If env is
// bare `process.env`, a design owner who only has per-user browser auth
// would land the chat id under the operator's HOME and the subsequent
// `--resume` (with the user-scoped `spawnEnv`) would not find it. Pass
// the same userId-aware env to both so the chat id + resume share the
// same HOME tree.
function createDesignCursorChat(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const CURSOR_BIN = getDeps().getCursorBin();
  return new Promise((resolve, reject) => {
    execFile(CURSOR_BIN, ['create-chat'], { cwd, env }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`cursor create-chat failed: ${stderr || err.message}`));
        return;
      }
      const id = (stdout || '').trim().split(/\s+/).pop();
      if (!id) {
        reject(new Error('cursor create-chat returned no id'));
        return;
      }
      resolve(id);
    });
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────

export interface DesignStatus {
  inFlight: boolean;
  messageId: string | null;
  streaming: string;
}

export function getDesignStatus(designId: string): DesignStatus {
  const state = activeDesignProcesses.get(designId);
  if (!state) return { inFlight: false, messageId: null, streaming: '' };
  return {
    inFlight: true,
    messageId: state.messageId,
    streaming: state.lastStream,
  };
}

export function handleDesignCancel(designId: string): void {
  const state = activeDesignProcesses.get(designId);
  if (!state) return;
  state.cancelled = true;
  if (state.proc) killProcessGroup(state.proc, 'SIGTERM');
}

// ─── System prompt assembly ────────────────────────────────────────────

export function buildDesignSystemPrompt(
  design: DesignWithProjects,
  opts: { designsRoot: string; defaultSkillsDir: string },
): string {
  const sections: string[] = [];

  const skillPath = path.join(opts.defaultSkillsDir, 'design', 'SKILL.md');
  if (existsSync(skillPath)) {
    try {
      const raw = readFileSync(skillPath, 'utf-8');
      const body = raw.replace(/^---[\s\S]*?---\s*/, '');
      sections.push(body.trim());
    } catch {
      // Skill file is best-effort — prompt still works without it.
    }
  }

  for (const project of design.linkedProjects) {
    const docs = readProjectDesignDocs(project);
    if (docs) {
      sections.push(`\n## Design System — ${project.name}\n\n${docs}`);
    }
  }

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

// ─── Main handler ──────────────────────────────────────────────────────

export async function handleDesignChat(
  ws: WebSocketLike | null,
  msg: DesignChatMsg,
): Promise<void> {
  const { designId, content } = msg;
  const d = getDeps();
  const { broadcast, stmts } = d;

  const design = d.getDesign(designId);
  if (!design) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown design: ${designId}` }));
    return;
  }

  if (!content || !content.trim()) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
    return;
  }

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

  const userMsgRow = appendDesignMessage(designId, 'user', content);
  broadcast({ type: 'design_message_added', designId, message: userMsgRow });

  const state: DesignState = {
    proc: null,
    cancelled: false,
    messageId: userMsgRow.id,
    lastStream: '',
  };
  activeDesignProcesses.set(designId, state);

  try {
    const config = d.getConfig();
    // No org-owner fallback — only the authenticated WS user.
    const designOwnerId = getWsAuthUserId(ws as unknown as AuthStampedWs | null) ?? null;
    const engine = normalizeDesignEngine(design.agent_engine);
    const model = resolveDesignModelForEngine(engine, design.agent_model, config, designOwnerId);
    let engineSessionId = design.engine_session_id ?? null;
    const startedWithoutSession = !engineSessionId;

    const designsRoot = d.getDesignsRoot();
    const defaultSkillsDir = d.getDefaultSkillsDir();
    const designDir = path.join(designsRoot, designId);
    const systemPrompt = buildDesignSystemPrompt(design, { designsRoot, defaultSkillsDir });

    // Build the spawn env BEFORE `create-chat` so `cursor-agent create-chat`
    // and the subsequent `--resume` see the same HOME tree. A design owner
    // with only per-user browser auth needs `HOME=<dataDir>/per-user-creds/<uid>/home`
    // (synthesised by `buildSpawnEnv({ userId })`) on both spawns — otherwise
    // the new chat id lands in the operator HOME and the resume call can't
    // find it. See review comment on PR #1072.
    const spawnEnv = {
      ...resolveSessionCliSpawnEnv({
        cfg: config,
        ownerId: designOwnerId,
        credsOwnerId: designOwnerId,
        sessionId: null,
        engine,
      }),
      AGENT_HUB_SESSION_ID: `design:${designId}`,
    } as NodeJS.ProcessEnv;
    const linkedProject = design.linkedProjects?.[0];
    let designAwsSsoEnabled = false;
    if (linkedProject && designOwnerId) {
      designAwsSsoEnabled = projectHasAwsSsoProfiles(linkedProject);
      mergeSkillCredentialSpawnEnv(spawnEnv, {
        ownerId: designOwnerId,
        agentId: DESIGN_SKILL_PRINCIPAL_AGENT_ID,
        project: linkedProject,
      });
      mergeProjectSecretsSpawnEnv(spawnEnv, {
        projectId: linkedProject.id,
        sessionId: `design:${designId}`,
      });
      mergeProjectAwsSpawnEnv(spawnEnv, linkedProject);
    }

    if (engine === 'cursor-agent' && !engineSessionId) {
      try {
        engineSessionId = await createDesignCursorChat(designDir, spawnEnv);
        stmts.updateDesignEngineSessionId.run(engineSessionId, designId);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'design_error', designId, error: errMsg });
        const assistantErr = appendDesignMessage(designId, 'assistant', `[error] ${errMsg}`);
        broadcast({ type: 'design_message_added', designId, message: assistantErr });
        return;
      }
    }

    const isNewEngineSession = startedWithoutSession;
    const history = listDesignMessages(designId) as DesignMessageRow[];
    const priorMessages = history.slice(0, -1);

    let bin: string;
    let args: string[];
    try {
      ({ bin, args } = buildDesignSpawnArgs({
        engine,
        model,
        designId,
        systemPrompt,
        cliContent: content.trim(),
        priorMessages,
        engineSessionId,
        isNewEngineSession,
        bins: {
          claude: d.getClaudeBin(),
          cursor: d.getCursorBin(),
          gemini: d.getGeminiBin(),
          codex: d.getCodexBin(),
          grok: d.getGrokBin(),
        },
        codexDangerBypass: !!config.codexDangerBypass,
        codexProfile: config.codexProfile,
        awsSsoEnabled: designAwsSsoEnabled,
        awsAccessEnv: designAwsSsoEnabled
          ? { HOME: spawnEnv.HOME, AWS_CONFIG_FILE: spawnEnv.AWS_CONFIG_FILE }
          : undefined,
      }));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'design_error', designId, error: errMsg });
      const assistantErr = appendDesignMessage(designId, 'assistant', `[error] ${errMsg}`);
      broadcast({ type: 'design_message_added', designId, message: assistantErr });
      return;
    }

    broadcast({
      type: 'design_thinking',
      designId,
      messageId: userMsgRow.id,
    });

    const parser = createStreamParser(engine);
    let buffers = { finalText: '', partialFallback: '' };
    let toolResultOutputs = '';
    let streamErrorMessage = '';
    let errorOutput = '';
    let spawnErrored = false;
    let codexThreadPersisted = !!(engine === 'codex-cli' && design.engine_session_id);

    if (engine === 'codex-cli' && spawnEnv.AGENT_HUB_AWS_PROFILE_NAMES) {
      linkAwsSsoHostCacheIntoSpawnHome(spawnEnv);
    }

    const finalTextOut = await new Promise<string>((resolve, reject) => {
      const timeout = config.defaultTimeoutMs;
      const proc = spawn(bin, args, {
        cwd: designDir,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }) as ChildProcess;
      state.proc = proc;
      trackChild(proc);

      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGTERM');
        reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
      }, timeout);

      const handleEvent = (event: StreamEvent): void => {
        if (event.type === 'assistant_text') {
          const text =
            typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
          const { next } = applyAssistantTextChunkForDelegationKickoff(
            buffers,
            text,
            !!event.partial,
            event.replacesAssistantBuffer ? { replace: true } : undefined,
          );
          buffers = next;
          const visible = accumulateAssistantStreamForDelegateKickoff(
            buffers.finalText,
            buffers.partialFallback,
          );
          state.lastStream = visible;
          broadcast({
            type: 'design_stream',
            designId,
            content: visible,
          });
        }

        if (
          engine === 'codex-cli' &&
          event.type === 'system' &&
          event.sessionId &&
          !codexThreadPersisted
        ) {
          codexThreadPersisted = true;
          try {
            stmts.updateDesignEngineSessionId.run(event.sessionId, designId);
          } catch (e: unknown) {
            const m = e instanceof Error ? e.message : String(e);
            console.warn('[design] Failed to persist codex engine_session_id:', m);
          }
        }

        if (event.type === 'tool_result' && event.output) {
          toolResultOutputs += '\n' + event.output;
        }

        if (event.type === 'result' && event.isError && event.text) {
          if (!streamErrorMessage) streamErrorMessage = event.text;
        }
        if (
          event.type === 'unknown' &&
          typeof event.text === 'string' &&
          (event.text.startsWith('codex error:') || event.text.startsWith('codex item error:'))
        ) {
          if (!streamErrorMessage) streamErrorMessage = event.text;
        }
      };

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const event of parser.feed(chunk)) handleEvent(event);
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
        if (spawnErrored) return;

        for (const event of parser.flush()) handleEvent(event);

        const assembled = (buffers.finalText || buffers.partialFallback).trim() + toolResultOutputs;

        if (code !== 0 && !assembled) {
          let errorMsg = pickProcessErrorMessage({
            stderr: errorOutput,
            streamErrorMessage,
            engine,
            exitCode: code,
          });
          if (code === -2 || code === -13) {
            const configKey =
              engine === 'cursor-agent'
                ? 'cursorBin'
                : engine === 'gemini-cli'
                  ? 'geminiBin'
                  : engine === 'codex-cli'
                    ? 'codexBin'
                    : engine === 'grok-cli'
                      ? 'grokBin'
                      : 'claudeBin';
            const reason = code === -2 ? 'not found (ENOENT)' : 'not executable (EACCES)';
            errorMsg =
              `${engine} binary ${reason} at ${bin}. ` +
              `Update ${configKey} in Settings (or ~/.agent-hub/data/config.json) to the correct path.`;
          }
          reject(new Error(errorMsg));
          return;
        }

        resolve(assembled.trim() || errorOutput.trim() || '(empty response)');
      });

      proc.on('error', (err: Error) => {
        spawnErrored = true;
        clearTimeout(timer);
        state.proc = null;
        reject(err);
      });
    });

    if (engine === 'claude-code' && startedWithoutSession) {
      try {
        stmts.updateDesignEngineSessionId.run(designId, designId);
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        console.warn('[design] Failed to persist claude engine_session_id:', m);
      }
    }

    const assistantMsg = appendDesignMessage(designId, 'assistant', finalTextOut);
    broadcast({ type: 'design_message_added', designId, message: assistantMsg });
    broadcast({ type: 'design_updated', designId });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (state.cancelled) {
      broadcast({ type: 'design_cancelled', designId });
    } else {
      broadcast({ type: 'design_error', designId, error: errMsg });
      const assistantErr = appendDesignMessage(designId, 'assistant', `[error] ${errMsg}`);
      broadcast({ type: 'design_message_added', designId, message: assistantErr });
    }
  } finally {
    activeDesignProcesses.delete(designId);
  }
}
