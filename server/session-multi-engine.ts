/**
 * Multi-agent session advisory spawn helpers — CLI argv planning for
 * read-only advisor turns in multi-agent sessions.
 */
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';

export const SESSION_MULTI_ENGINES = [
  'claude-code',
  'cursor-agent',
  'gemini-cli',
  'codex-cli',
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
}

export interface SessionMultiSpawnPlan {
  bin: string;
  args: string[];
  stdinPrompt: string | null;
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
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    return {
      bin: bins.cursor,
      args: [
        '-p',
        prompt,
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
    };
  }

  if (engine === 'gemini-cli') {
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    if (!advisory) {
      args.push('--yolo');
    }
    return { bin: bins.gemini, args, stdinPrompt: null };
  }

  if (engine === 'codex-cli') {
    const args: string[] = ['exec', '--json', '--skip-git-repo-check'];
    appendCodexExecSandboxFlags(args, {
      askMode: advisory,
      dangerBypass: !advisory && !!codexDangerBypass,
    });
    const codexAuth = detectCodexAuthMode();
    if (model && shouldPassModelFlag(codexAuth.mode, model)) {
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
    return { bin: bins.codex, args, stdinPrompt: prompt };
  }

  const args: string[] = [
    '--print',
    '--permission-mode',
    claudePermissionModeForSpawn(advisory ? 'plan' : 'bypassPermissions'),
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...disableNativeSkillToolArgs(),
    '--',
    userPrompt,
  ];
  return { bin: bins.claude, args, stdinPrompt: null };
}
