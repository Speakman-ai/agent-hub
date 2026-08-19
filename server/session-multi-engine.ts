/**
 * Multi-agent session advisory spawn helpers — CLI argv planning for
 * read-only advisor turns in multi-agent sessions.
 */
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { advertisedCapabilityModelsForEnv } from './codex-model-capability.js';
import {
  appendCodexExecSandboxFlags,
  appendCodexShellEnvironmentPolicyArgs,
} from './codex-exec-sandbox.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import {
  applyArgvPromptCap,
  logArgvCapTruncation,
  SAFE_ARG_STRLEN_BYTES,
  writeSystemPromptFile,
} from './spawn-prompt-payload.js';
import { resolveGrokSpawnModel } from './config.js';
import { withLocalCommitReminder } from './local-commit-reminder.js';
import type { AppConfig } from './types.js';

export const SESSION_MULTI_ENGINES = [
  'claude-code',
  'cursor-agent',
  'gemini-cli',
  'codex-cli',
  'grok-cli',
] as const;

export type SessionMultiEngine = (typeof SESSION_MULTI_ENGINES)[number];

export function isSessionMultiEngine(s: string): s is SessionMultiEngine {
  return (SESSION_MULTI_ENGINES as readonly string[]).includes(s);
}

export function normalizeSessionMultiEngine(engine: string | null | undefined): SessionMultiEngine {
  const e = typeof engine === 'string' ? engine.trim() : '';
  if (e && isSessionMultiEngine(e)) return e;
  return 'claude-code';
}

export interface SessionSpawnBins {
  claude: string;
  cursor: string;
  gemini: string;
  codex: string;
  grok?: string;
}

export interface BuildSessionMultiSpawnArgsInput {
  engine: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cursorChatId?: string | null;
  bins: SessionSpawnBins;
  logTag?: string;
  codexDangerBypass?: boolean;
  /**
   * Optional Codex CLI profile name. When set, advisor turns on the
   * codex-cli engine get `--profile <name>` appended so the CLI loads the
   * matching profile from `~/.codex/config.toml`. Empty / unset = no flag.
   */
  codexProfile?: string | null;
  /** When true, force read-only / ask-mode spawn (advisor turns). */
  advisory?: boolean;
  /** Used for `--system-prompt-file` temp paths and argv-cap logging. */
  sessionId?: string;
  codexEnv?: NodeJS.ProcessEnv;
  /** Needed to allowlist/alias the grok `--model` flag. */
  config?: Pick<AppConfig, 'engineValidModels' | 'engineDefaultModels'>;
}

export interface SessionMultiSpawnPlan {
  bin: string;
  args: string[];
  stdinPrompt: string | null;
  /** Best-effort rm of per-spawn system-prompt temp dir (claude-code). */
  systemPromptFileCleanup?: (() => void) | null;
}

export function buildSessionMultiSpawnArgs(
  input: BuildSessionMultiSpawnArgsInput,
): SessionMultiSpawnPlan {
  const {
    engine,
    model,
    systemPrompt,
    userPrompt,
    cursorChatId,
    bins,
    logTag,
    codexDangerBypass,
    codexProfile,
    advisory = false,
  } = input;

  if (engine === 'cursor-agent') {
    if (!cursorChatId) {
      throw new Error(
        'buildSessionMultiSpawnArgs: cursor-agent requires cursorChatId (call createCursorChat first)',
      );
    }
    const rawPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const capped = applyArgvPromptCap(rawPrompt);
    if (capped.truncated && input.sessionId) {
      logArgvCapTruncation('cursor-agent', input.sessionId, capped.originalBytes, rawPrompt.length);
    }
    return {
      bin: bins.cursor,
      args: [
        '-p',
        capped.prompt,
        ...(advisory ? [] : ['--force']),
        '--model',
        model,
        '--resume',
        cursorChatId,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ],
      stdinPrompt: null,
      systemPromptFileCleanup: null,
    };
  }

  if (engine === 'gemini-cli') {
    const rawPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const capped = applyArgvPromptCap(rawPrompt);
    if (capped.truncated && input.sessionId) {
      logArgvCapTruncation('gemini-cli', input.sessionId, capped.originalBytes, rawPrompt.length);
    }
    const args = ['-p', capped.prompt, '--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    if (!advisory) {
      args.push('--yolo');
    }
    return { bin: bins.gemini, args, stdinPrompt: null, systemPromptFileCleanup: null };
  }

  if (engine === 'grok-cli') {
    if (!bins.grok) {
      throw new Error('buildSessionMultiSpawnArgs: grok-cli requires bins.grok');
    }
    // Grok has no `--system-prompt`; concatenate like Gemini. streaming-json is
    // required because callers (in-session reviewer, multi-agent advisors) feed
    // stdout through createStreamParser('grok-cli'). Omit `--always-approve` on
    // advisory turns to match chat Ask Mode.
    const rawPrompt = advisory
      ? `${systemPrompt}\n\n${userPrompt}`
      : withLocalCommitReminder(`${systemPrompt}\n\n${userPrompt}`);
    const capped = applyArgvPromptCap(rawPrompt);
    if (capped.truncated && input.sessionId) {
      logArgvCapTruncation('grok-cli', input.sessionId, capped.originalBytes, rawPrompt.length);
    }
    const args = ['-p', capped.prompt, '--output-format', 'streaming-json', '--no-auto-update'];
    const grokModel = input.config
      ? resolveGrokSpawnModel(model, input.config)
      : model?.trim() || undefined;
    if (grokModel) {
      args.push('--model', grokModel);
    }
    if (!advisory) {
      args.push('--always-approve');
    }
    return { bin: bins.grok, args, stdinPrompt: null, systemPromptFileCleanup: null };
  }

  if (engine === 'codex-cli') {
    const args: string[] = ['exec', '--json', '--skip-git-repo-check'];
    appendCodexExecSandboxFlags(args, {
      askMode: advisory,
      dangerBypass: !advisory && !!codexDangerBypass,
    });
    appendCodexShellEnvironmentPolicyArgs(args, input.codexEnv);
    const codexAuth = detectCodexAuthMode();
    if (
      model &&
      shouldPassModelFlag(
        codexAuth.mode,
        model,
        advertisedCapabilityModelsForEnv(input.codexEnv ?? process.env),
      )
    ) {
      args.push('--model', model);
    } else if (model) {
      console.warn(
        `[session-multi] Dropping --model ${model} for codex-cli ${logTag ?? 'turn'}: ` +
          `auth_mode=${codexAuth.mode} does not accept it.`,
      );
    }
    // `?.trim()` guards against an in-memory PATCH config value that wasn't
    // run through the load-time normalizer in `config.ts`. Must come BEFORE
    // the `-` stdin sentinel push below.
    const codexProfileVal = codexProfile?.trim();
    if (codexProfileVal) {
      args.push('--profile', codexProfileVal);
    }
    args.push('-');
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    return { bin: bins.codex, args, stdinPrompt: prompt, systemPromptFileCleanup: null };
  }

  let systemPromptFileCleanup: (() => void) | null = null;
  let claudeSystemPromptArg: string;
  if (input.sessionId) {
    const promptFile = writeSystemPromptFile(systemPrompt, input.sessionId);
    systemPromptFileCleanup = promptFile.cleanup;
    claudeSystemPromptArg = promptFile.path;
  } else {
    claudeSystemPromptArg = systemPrompt;
  }

  // The claude CLI takes the user prompt as a positional argv argument, so a
  // large prompt — e.g. a fix turn that embeds verbose CI step logs, or a big
  // local-diff reviewer prompt — overflows ARG_MAX and the spawn dies with
  // `spawn E2BIG`. Cap it exactly like the chat path does (the system prompt is
  // already file-backed above, so it's never the culprit).
  const cappedUserPrompt = applyArgvPromptCap(userPrompt);
  if (cappedUserPrompt.truncated && input.sessionId) {
    logArgvCapTruncation(
      'session-multi-user',
      input.sessionId,
      cappedUserPrompt.originalBytes,
      SAFE_ARG_STRLEN_BYTES,
    );
  }
  const args: string[] = [
    '--print',
    '--permission-mode',
    claudePermissionModeForSpawn(advisory ? 'plan' : 'bypassPermissions'),
    '--model',
    model,
    ...(input.sessionId
      ? (['--system-prompt-file', claudeSystemPromptArg] as const)
      : (['--system-prompt', claudeSystemPromptArg] as const)),
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...disableNativeSkillToolArgs(),
    '--',
    cappedUserPrompt.prompt,
  ];
  return { bin: bins.claude, args, stdinPrompt: null, systemPromptFileCleanup };
}
