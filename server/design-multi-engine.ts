/**
 * Design Studio multi-engine helpers — model resolution and CLI argv planning
 * for `design-chat.ts`. See `design-multi-engine.test.ts` for Vitest coverage.
 */
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { defaultModelForEngine } from './config.js';
import { disableNativeSkillToolArgs } from './claude-cli-args.js';
import type { AppConfig, DesignMessageRow } from './types.js';

export const DESIGN_CHAT_ENGINES = [
  'claude-code',
  'cursor-agent',
  'gemini-cli',
  'codex-cli',
] as const;

export type DesignChatEngine = (typeof DESIGN_CHAT_ENGINES)[number];

export function isDesignChatEngine(s: string): s is DesignChatEngine {
  return (DESIGN_CHAT_ENGINES as readonly string[]).includes(s);
}

/** Default when `designs.agent_engine` is null/empty — matches historical behavior. */
export function normalizeDesignEngine(engine: string | null | undefined): DesignChatEngine {
  const e = typeof engine === 'string' ? engine.trim() : '';
  if (e && isDesignChatEngine(e)) return e;
  return 'claude-code';
}

/**
 * Resolve the CLI model id for a design row. Uses the per-engine allowlist in
 * config; null/empty `agent_model` falls back to `defaultModelForEngine(engine)`.
 */
export function resolveDesignModelForEngine(
  engine: string,
  agentModel: string | null | undefined,
  cfg: AppConfig,
): string {
  const allowed = cfg.engineValidModels[engine] || [];
  const configured = typeof agentModel === 'string' ? agentModel.trim() : '';
  if (configured && allowed.includes(configured)) {
    return configured;
  }
  const fallback = defaultModelForEngine(engine);
  if (allowed.length === 0 || allowed.includes(fallback)) {
    return fallback;
  }
  return allowed[0] ?? fallback;
}

/** @deprecated use resolveDesignModelForEngine('claude-code', …) */
export function resolveDesignStudioModel(
  agentModel: string | null | undefined,
  cfg: AppConfig,
): string {
  return resolveDesignModelForEngine('claude-code', agentModel, cfg);
}

/**
 * Build the `Human:` / `Assistant:` history block used for first-turn bootstrap
 * (mirrors server/chat.ts). Excludes the latest user message (still in flight as
 * `cliContent` passed separately).
 */
export function buildDesignHistoryBootstrap(prior: DesignMessageRow[]): string {
  if (prior.length === 0) return '';
  let p = 'Previous conversation:\n';
  for (const m of prior) {
    const prefix = m.role === 'user' ? 'Human' : 'Assistant';
    p += `${prefix}: ${m.content}\n\n`;
  }
  return p;
}

export interface DesignSpawnBins {
  claude: string;
  cursor: string;
  gemini: string;
  codex: string;
}

export interface BuildDesignSpawnArgsInput {
  engine: string;
  model: string;
  designId: string;
  systemPrompt: string;
  /** Latest user message text only. */
  cliContent: string;
  /** Prior design_messages (excludes the user row just appended for this turn). */
  priorMessages: DesignMessageRow[];
  engineSessionId: string | null;
  isNewEngineSession: boolean;
  bins: DesignSpawnBins;
}

/**
 * Plan `spawn(bin, args, { cwd: designDir })` for Design Studio. Caller supplies
 * absolute bins from config.
 */
export function buildDesignSpawnArgs(input: BuildDesignSpawnArgsInput): {
  bin: string;
  args: string[];
} {
  const {
    engine,
    model,
    designId,
    systemPrompt,
    cliContent,
    priorMessages,
    engineSessionId,
    isNewEngineSession,
    bins,
  } = input;

  const needsHistoryBootstrap = isNewEngineSession && priorMessages.length > 0;
  const historyPrefix = needsHistoryBootstrap ? buildDesignHistoryBootstrap(priorMessages) : '';
  const promptWithHistory = needsHistoryBootstrap
    ? `${historyPrefix}Human: ${cliContent}`
    : cliContent;

  if (engine === 'cursor-agent') {
    if (!engineSessionId) {
      throw new Error('buildDesignSpawnArgs: cursor-agent requires engineSessionId before spawn');
    }
    const prompt = isNewEngineSession ? `${systemPrompt}\n\n${promptWithHistory}` : cliContent;
    return {
      bin: bins.cursor,
      args: [
        '-p',
        prompt,
        '--force',
        '--model',
        model,
        '--resume',
        engineSessionId,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ],
    };
  }

  if (engine === 'gemini-cli') {
    const prompt = `${systemPrompt}\n\n${promptWithHistory}`;
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    // Design Studio has no Ask/plan mode (unlike chat.ts, which omits --yolo
    // when `session.ask_mode` is set). Always auto-approve tools for parity
    // with Claude's bypassPermissions default.
    args.push('--yolo');
    return { bin: bins.gemini, args };
  }

  if (engine === 'codex-cli') {
    if (!isNewEngineSession && !engineSessionId) {
      throw new Error(
        'buildDesignSpawnArgs: codex-cli resume requires engine_session_id on the design row',
      );
    }
    const prompt = isNewEngineSession ? `${systemPrompt}\n\n${promptWithHistory}` : cliContent;
    const args = ['exec'];
    if (!isNewEngineSession && engineSessionId) {
      args.push('resume', engineSessionId);
    }
    args.push('--json', '--skip-git-repo-check', '--full-auto');
    const codexAuth = detectCodexAuthMode();
    if (model && shouldPassModelFlag(codexAuth.mode, model)) {
      args.push('--model', model);
    } else if (model) {
      console.warn(
        `[design] Dropping --model ${model} for codex-cli design ${designId}: ` +
          `auth_mode=${codexAuth.mode} does not accept it. Falling back to codex default.`,
      );
    }
    args.push(prompt);
    return { bin: bins.codex, args };
  }

  // claude-code (default)
  if (!isNewEngineSession && !engineSessionId) {
    throw new Error(
      'buildDesignSpawnArgs: claude-code resume requires engine_session_id on the design row',
    );
  }
  const args: string[] = [
    '--print',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // see claude-cli-args.ts
    ...disableNativeSkillToolArgs(),
  ];
  if (isNewEngineSession) {
    args.push('--session-id', designId);
  } else {
    args.push('--resume', engineSessionId as string);
  }
  args.push(promptWithHistory);
  return { bin: bins.claude, args };
}
