/**
 * Design Studio multi-engine helpers — model resolution and CLI argv planning
 * for `design-chat.ts`. See `design-multi-engine.test.ts` for Vitest coverage.
 */
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { advertisedCapabilityModelsForEnv } from './codex-model-capability.js';
import { codexReasoningArgs } from './codex-reasoning.js';
import config, { resolveGrokSpawnModel } from './config.js';
import {
  appendCodexAwsAccessDirs,
  appendCodexExecSandboxFlags,
  appendCodexShellEnvironmentPolicyArgs,
} from './codex-exec-sandbox.js';
import { resolveEffectiveModel } from './effective-model.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import { DESIGN_SKILL_PRINCIPAL_AGENT_ID } from './design-skill-principal.js';
import type { AppConfig, DesignMessageRow } from './types.js';

// `gemini-cli` is intentionally excluded — Gemini is RAG-only (see
// RAG_ONLY_ENGINES in engine-availability.ts) and the interactive Gemini CLI is
// unusable (Pro free tier zeroed to `limit: 0` on 2026-04-01). Keep aligned
// with SELECTABLE_ENGINES / the web DESIGN_STUDIO_ENGINES list.
export const DESIGN_CHAT_ENGINES = [
  'claude-code',
  'cursor-agent',
  'codex-cli',
  'grok-cli',
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
 * Resolve the CLI model id for a design row. Validates against the per-engine
 * allowlist in config. When `agent_model` is null/invalid, falls back via
 * `resolveEffectiveModel` (per-user defaults, then hub engine default).
 */
export function resolveDesignModelForEngine(
  engine: string,
  agentModel: string | null | undefined,
  cfg: AppConfig,
  ownerUserId?: string | null,
): string {
  const allowed = cfg.engineValidModels[engine] || [];
  const configured = typeof agentModel === 'string' ? agentModel.trim() : '';
  const explicit = configured && allowed.includes(configured) ? configured : null;
  let resolved = resolveEffectiveModel(cfg, engine, {
    explicitModel: explicit,
    agentModel: null,
    ownerUserId: ownerUserId ?? null,
    agentId: DESIGN_SKILL_PRINCIPAL_AGENT_ID,
  });
  if (allowed.length === 0 || allowed.includes(resolved)) {
    return resolved;
  }
  return allowed[0] ?? resolved;
}

/** @deprecated use resolveDesignModelForEngine('claude-code', …) */
export function resolveDesignStudioModel(
  agentModel: string | null | undefined,
  cfg: AppConfig,
  ownerUserId?: string | null,
): string {
  return resolveDesignModelForEngine('claude-code', agentModel, cfg, ownerUserId);
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
  grok: string;
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
  /**
   * Host setting: Codex full bypass instead of `--full-auto` (matches chat).
   */
  codexDangerBypass?: boolean;
  /**
   * Host setting: optional Codex CLI profile name. Forwarded as
   * `--profile <name>` on the codex-cli branch only. Empty / unset = no flag.
   */
  codexProfile?: string | null;
  awsSsoEnabled?: boolean;
  awsAccessEnv?: Pick<NodeJS.ProcessEnv, 'HOME' | 'AWS_CONFIG_FILE'>;
  codexEnv?: NodeJS.ProcessEnv;
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
    codexDangerBypass,
    codexProfile,
    awsSsoEnabled,
    awsAccessEnv,
    codexEnv,
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

  // NOTE: no `gemini-cli` branch — Gemini is RAG-only and not a Design Studio
  // engine (see DESIGN_CHAT_ENGINES / RAG_ONLY_ENGINES). The route rejects it
  // before we ever plan a spawn.

  if (engine === 'grok-cli') {
    // Grok Build CLI is stateless here (like Gemini) — no resume flag, so the
    // system prompt + history bootstrap ride in the prompt body each turn.
    const prompt = `${systemPrompt}\n\n${promptWithHistory}`;
    const args = ['-p', prompt, '--output-format', 'streaming-json', '--no-auto-update'];
    const grokModel = resolveGrokSpawnModel(model, config);
    if (grokModel) {
      args.push('--model', grokModel);
    }
    // Design Studio has no Ask/plan mode — always auto-approve tool calls for
    // parity with Claude's bypassPermissions default.
    args.push('--always-approve');
    return { bin: bins.grok, args };
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
    args.push('--json', '--skip-git-repo-check');
    appendCodexExecSandboxFlags(args, {
      askMode: false,
      dangerBypass: !!codexDangerBypass,
      awsSsoEnabled: !!awsSsoEnabled,
      resume: !isNewEngineSession && !!engineSessionId,
    });
    if (awsSsoEnabled && awsAccessEnv) {
      appendCodexAwsAccessDirs(args, awsAccessEnv);
    }
    appendCodexShellEnvironmentPolicyArgs(args, codexEnv);
    const codexAuth = detectCodexAuthMode();
    if (
      model &&
      shouldPassModelFlag(
        codexAuth.mode,
        model,
        advertisedCapabilityModelsForEnv(codexEnv ?? process.env),
      )
    ) {
      args.push('--model', model);
    } else if (model) {
      console.warn(
        `[design] Dropping --model ${model} for codex-cli design ${designId}: ` +
          `auth_mode=${codexAuth.mode} does not accept it. Falling back to codex default.`,
      );
    }
    // `?.trim()` guards against an in-memory PATCH config value that wasn't
    // run through the load-time normalizer in `config.ts`. Must come BEFORE
    // the positional prompt push below — codex would otherwise treat the
    // profile name as the start of the prompt.
    const codexProfileVal = codexProfile?.trim();
    if (codexProfileVal) {
      args.push('--profile', codexProfileVal);
    }
    // Design Studio Codex runs have no per-session reasoning preset; use the
    // default (`high`) to match the interactive Codex default.
    args.push(...codexReasoningArgs(null));
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
    claudePermissionModeForSpawn('bypassPermissions'),
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
