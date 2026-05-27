/**
 * Conference-room multi-engine helpers — pure CLI argv planning for
 * `room-chat.ts`. Each room turn is stateless (no `engine_session_id`
 * tracking between turns — every spawn carries the full transcript as the
 * user prompt) so this is a thin wrapper that mirrors `chat.ts`'s engine
 * branches without the resume / MCP / image-attachment machinery.
 *
 * See `room-multi-engine.test.ts` for Vitest coverage.
 */
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { appendCodexAwsAccessDirs, appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';

export const ROOM_CHAT_ENGINES = [
  'claude-code',
  'cursor-agent',
  'gemini-cli',
  'codex-cli',
] as const;

export type RoomChatEngine = (typeof ROOM_CHAT_ENGINES)[number];

export function isRoomChatEngine(s: string): s is RoomChatEngine {
  return (ROOM_CHAT_ENGINES as readonly string[]).includes(s);
}

/** Default when `agent.engine` is null/empty/unknown. */
export function normalizeRoomEngine(engine: string | null | undefined): RoomChatEngine {
  const e = typeof engine === 'string' ? engine.trim() : '';
  if (e && isRoomChatEngine(e)) return e;
  return 'claude-code';
}

export interface RoomSpawnBins {
  claude: string;
  cursor: string;
  gemini: string;
  codex: string;
}

export interface BuildRoomSpawnArgsInput {
  engine: string;
  model: string;
  /** Enriched system prompt + room metadata + @mention rules (composed by caller). */
  systemPrompt: string;
  /** Transcript-derived user prompt for this turn. */
  userPrompt: string;
  /**
   * Cursor Agent requires a chat id to resume against. Room turns create a
   * fresh chat per spawn (rooms have no persistent engine_session_id), so
   * the caller obtains this id via `cursor-agent create-chat` before
   * calling and passes it here. Required when `engine === 'cursor-agent'`.
   */
  cursorChatId?: string | null;
  bins: RoomSpawnBins;
  /** Optional context for logging when an engine drops --model. */
  logTag?: string;
  /**
   * Host setting: pass Codex `--dangerously-bypass-approvals-and-sandbox`
   * instead of `--full-auto` for room turns (parity with chat.ts).
   */
  codexDangerBypass?: boolean;
  /** When set, widen Codex sandbox for Hub AWS SSO (parity with chat.ts). */
  awsSsoEnabled?: boolean;
  /** Spawn env fragment for `appendCodexAwsAccessDirs` (HOME + AWS_CONFIG_FILE). */
  awsAccessEnv?: Pick<NodeJS.ProcessEnv, 'HOME' | 'AWS_CONFIG_FILE'>;
}

export interface RoomSpawnPlan {
  bin: string;
  args: string[];
  /**
   * Set to a prompt string when the engine wants its prompt on stdin (codex
   * uses the `-` sentinel + stdin pipe to avoid the 128 KiB MAX_ARG_STRLEN
   * cliff). `null` for every other engine — the spawn site should open
   * stdio[0]='ignore' in that case so an over-eager CLI does not block on
   * a read that never arrives.
   */
  stdinPrompt: string | null;
}

/**
 * Plan `spawn(bin, args, …)` for one conference-room turn. Mirrors the
 * engine branches in `server/chat.ts` and `server/design-multi-engine.ts`,
 * stripped to a stateless one-shot shape (no resume, no MCP config, no
 * per-session prompt files).
 *
 * Every engine emits stream-json so the caller can wire one
 * `createStreamParser(engine)` for streaming + cancellation. Claude's
 * `--system-prompt` is inline (no temp file) because room turns compose a
 * smaller prompt than chat — `roomSystemPrompt` is the enriched prompt
 * + the multi-agent / @mention scaffold, not the full chat enrichment.
 */
export function buildRoomSpawnArgs(input: BuildRoomSpawnArgsInput): RoomSpawnPlan {
  const {
    engine,
    model,
    systemPrompt,
    userPrompt,
    cursorChatId,
    bins,
    logTag,
    codexDangerBypass,
    awsSsoEnabled,
    awsAccessEnv,
  } = input;

  if (engine === 'cursor-agent') {
    if (!cursorChatId) {
      throw new Error(
        'buildRoomSpawnArgs: cursor-agent requires cursorChatId (call createCursorChat first)',
      );
    }
    // Room turns are stateless — the chat id is freshly minted per turn, so
    // we always inject the enriched system prompt + transcript via `-p`.
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    return {
      bin: bins.cursor,
      args: [
        '-p',
        prompt,
        '--force',
        '--model',
        model,
        '--resume',
        cursorChatId,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ],
      stdinPrompt: null,
    };
  }

  if (engine === 'gemini-cli') {
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    // Conference rooms have no Ask Mode toggle — always auto-approve tools
    // for parity with the Claude bypassPermissions default the room used
    // before this change.
    args.push('--yolo');
    return { bin: bins.gemini, args, stdinPrompt: null };
  }

  if (engine === 'codex-cli') {
    // Each turn is a fresh codex exec (no `resume <thread-id>` because rooms
    // do not persist `engine_session_id` between turns).
    // Rooms have no Ask Mode; honour host `codexDangerBypass` like chat Codex.
    const args: string[] = ['exec', '--json', '--skip-git-repo-check'];
    appendCodexExecSandboxFlags(args, {
      askMode: false,
      dangerBypass: !!codexDangerBypass,
      awsSsoEnabled: !!awsSsoEnabled,
    });
    if (awsSsoEnabled && awsAccessEnv) {
      appendCodexAwsAccessDirs(args, awsAccessEnv);
    }
    const codexAuth = detectCodexAuthMode();
    if (model && shouldPassModelFlag(codexAuth.mode, model)) {
      args.push('--model', model);
    } else if (model) {
      console.warn(
        `[room] Dropping --model ${model} for codex-cli ${logTag ?? 'turn'}: ` +
          `auth_mode=${codexAuth.mode} does not accept it. Falling back to codex default.`,
      );
    }
    // Pass the prompt via stdin using the documented `-` sentinel — same
    // rationale as the chat.ts codex branch (sidesteps MAX_ARG_STRLEN).
    args.push('-');
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    return { bin: bins.codex, args, stdinPrompt: prompt };
  }

  // claude-code (default). Room spawns are one-shot --print invocations; we
  // emit stream-json + --verbose + --include-partial-messages so the
  // caller can feed events through `createStreamParser('claude-code')`
  // just like chat.ts.
  const args: string[] = [
    '--print',
    '--permission-mode',
    claudePermissionModeForSpawn('bypassPermissions'),
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // see claude-cli-args.ts — disables shadowed native Skill /
    // AskUserQuestion tools that Agent Hub replaces with its own protocols.
    ...disableNativeSkillToolArgs(),
    // `--` terminates option parsing so the variadic
    // `--disallowed-tools <tools...>` does not swallow the trailing
    // positional prompt (Claude CLI 2.x).
    '--',
    userPrompt,
  ];
  return { bin: bins.claude, args, stdinPrompt: null };
}
