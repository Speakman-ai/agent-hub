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
  writeCursorHubSessionRule,
} from './spawn-prompt-payload.js';
import { resolveGrokSpawnModel } from './config.js';
import { withLocalCommitReminder } from './local-commit-reminder.js';
import type { AppConfig } from './types.js';
import { resolveEffectiveEngineAndModel } from './effective-model.js';

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

export interface AdvisorEngineResolutionOpts {
  agentId: string;
  /** The advisor agent's shared/configured engine. */
  agentEngine: string | null | undefined;
  /** The advisor agent's shared/configured model. */
  agentModel?: string | null;
  /** Per-participant engine override (session_agents.engine); null → inherit. */
  sessionEngine?: string | null;
  /** Per-participant model override (session_agents.model). */
  sessionModel?: string | null;
  /** Session owner's user id, so per-user engine/model overrides apply. */
  ownerUserId?: string | null;
}

/**
 * Single source of truth for the engine + model an advisor turn spawns with.
 * Precedence (highest first): per-participant override → per-user override →
 * agent's configured engine. The **same** resolution must drive both the
 * runtime spawn (`runAdvisorTurn`) and the reported roster engine
 * (`listSessionAgents`) — otherwise the UI's model picker can be seeded from a
 * different engine than the CLI actually runs (e.g. reported Claude, spawned
 * Codex via a per-user override).
 */
export function resolveAdvisorEngineAndModel(
  config: AppConfig,
  opts: AdvisorEngineResolutionOpts,
): { engine: SessionMultiEngine; model: string } {
  const { engine, model } = resolveEffectiveEngineAndModel(config, {
    agentId: opts.agentId,
    agentEngine: normalizeSessionMultiEngine(opts.agentEngine),
    agentModel: opts.agentModel ?? undefined,
    ownerUserId: opts.ownerUserId,
    // A per-participant engine override forces that CLI for this advisor
    // instance (the swarm cross-verification case); null falls through to the
    // per-user override and then the agent's engine.
    explicitEngine: opts.sessionEngine ? normalizeSessionMultiEngine(opts.sessionEngine) : null,
    explicitModel: opts.sessionModel,
  });
  return { engine: normalizeSessionMultiEngine(engine), model };
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
  /**
   * Finalize reviewer unified diff, delivered on an unbounded channel
   * (Cursor session rule, Claude system-prompt file, Gemini/Codex/Grok stdin)
   * so argv cannot omit implementation files. Advisory chat turns omit this.
   */
  reviewCorpus?: string | null;
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
  /**
   * Finalize in-session reviewer turn: read-only. Auto-approve stays on so
   * headless engines do not block on a tool-approval that never arrives.
   * The unified diff is attached out of band (`reviewCorpus`); the reviewer
   * must not depend on worktree Read/cat. The system prompt still forbids
   * edits/commits/pushes.
   */
  reviewerReadOnly?: boolean;
  /**
   * Directive pinned at the very end of the combined prompt. Concatenated-argv
   * engines (grok/gemini/cursor) push `systemPrompt + userPrompt` through a
   * single `-p` argument, so a large enriched system prompt plus a big diff can
   * exceed {@link SAFE_ARG_STRLEN_BYTES}; `applyArgvPromptCap` then keeps the
   * tail and drops the head (the Finalize "no PR / do not stop" override). A
   * short reminder placed last survives that trim.
   */
  tailReminder?: string;
  /**
   * Spawn cwd. Required for cursor-agent to write the Hub always-apply
   * rule file; when omitted we fall back to the argv cap (tests / callers
   * that have not been wired yet).
   */
  cwd?: string;
  /** Used for `--system-prompt-file` temp paths and argv-cap logging. */
  sessionId?: string;
  codexEnv?: NodeJS.ProcessEnv;
  /** Needed to allowlist/alias the grok `--model` flag. */
  config?: Pick<AppConfig, 'engineValidModels' | 'engineDefaultModels'>;
}

export interface SessionMultiSpawnPlan {
  bin: string;
  args: string[];
  /** Written to the child's stdin (codex `-` sentinel; gemini Hub-rules prefix). */
  stdinPrompt: string | null;
  /**
   * Best-effort cleanup after the child closes: the claude-code system-prompt
   * temp dir, or the cursor-agent per-session `.mdc` rule file.
   */
  systemPromptFileCleanup?: (() => void) | null;
  /** Merged into the child env. Currently unused (kept as a forward seam). */
  extraEnv?: Record<string, string> | null;
}

export function buildSessionMultiSpawnArgs(
  input: BuildSessionMultiSpawnArgsInput,
): SessionMultiSpawnPlan {
  const {
    engine,
    model,
    systemPrompt,
    userPrompt,
    reviewCorpus,
    cursorChatId,
    bins,
    logTag,
    codexDangerBypass,
    codexProfile,
    advisory = false,
    reviewerReadOnly = false,
    tailReminder,
  } = input;

  // Pin `tailReminder` (if any) as the LAST thing in the combined prompt so
  // `applyArgvPromptCap`'s tail-keep can never drop it. Reviewer turns need
  // the emit-verdict contract to survive even if the argv user prompt is
  // trimmed; the unified diff itself must not ride argv.
  const withTailReminder = (prompt: string): string =>
    tailReminder ? `${prompt}\n\n${tailReminder}` : prompt;

  const systemWithCorpus = reviewCorpus ? `${systemPrompt}\n\n${reviewCorpus}` : systemPrompt;

  if (engine === 'cursor-agent') {
    if (!cursorChatId) {
      throw new Error(
        'buildSessionMultiSpawnArgs: cursor-agent requires cursorChatId (call createCursorChat first)',
      );
    }
    // Write the Hub rules to a collision-resistant per-session `.cursor/rules`
    // file (loaded from disk, never trimmed by the argv cap) so `-p` stays
    // user-only. Needs a cwd and a sessionId to scope the filename; without
    // either, or on a genuine write hazard, fall back to inlining the system
    // prompt into `-p` (capped) so Cursor still receives the Hub rules —
    // except a Finalize review corpus never falls back to argv (throws below).
    const ruleWrite =
      input.cwd != null && input.sessionId
        ? writeCursorHubSessionRule(input.cwd, systemWithCorpus, input.sessionId)
        : null;
    // Never put a review corpus through `-p`. Cursor's argv cap would drop
    // the head (the corpus) and the reviewer would try to Read/cat omitted
    // files — the loop this delivery exists to stop. Fail over instead.
    if (reviewCorpus && !ruleWrite) {
      throw new Error(
        'buildSessionMultiSpawnArgs: cursor-agent cannot attach a review corpus without a session-scoped Hub rule file',
      );
    }
    let prompt: string;
    if (ruleWrite) {
      const rawUser = withTailReminder(userPrompt);
      const capped = applyArgvPromptCap(rawUser);
      if (capped.truncated && input.sessionId) {
        logArgvCapTruncation(
          'cursor-agent-user',
          input.sessionId,
          capped.originalBytes,
          Buffer.byteLength(rawUser, 'utf8'),
        );
      }
      prompt = capped.prompt;
    } else {
      const rawPrompt = withTailReminder(`${systemWithCorpus}\n\n${userPrompt}`);
      const capped = applyArgvPromptCap(rawPrompt);
      if (capped.truncated && input.sessionId) {
        logArgvCapTruncation(
          'cursor-agent',
          input.sessionId,
          capped.originalBytes,
          rawPrompt.length,
        );
      }
      prompt = capped.prompt;
    }
    return {
      bin: bins.cursor,
      args: [
        '-p',
        prompt,
        // `--force` auto-approves tool calls. Reviewer turns keep it so a
        // stray tool call cannot stall headless; the corpus is already
        // attached and edits stay forbidden by the system prompt.
        ...(advisory && !reviewerReadOnly ? [] : ['--force']),
        '--model',
        model,
        '--resume',
        cursorChatId,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ],
      stdinPrompt: null,
      systemPromptFileCleanup: ruleWrite ? ruleWrite.cleanup : null,
    };
  }

  if (engine === 'gemini-cli') {
    // Deliver the Hub rules on STDIN (unbounded), not GEMINI_SYSTEM_MD and not
    // the head of `-p`. GEMINI_SYSTEM_MD *fully replaces* Gemini's built-in core
    // system prompt (safety, tool operation, approval, reliability) with no
    // token to restore it, and inlining at the head of `-p` lets the argv cap
    // trim the rules. Gemini prepends stdin to the `-p` user turn, so the whole
    // core prompt is preserved and the Hub payload can never be truncated.
    const rawUser = withTailReminder(userPrompt);
    const capped = applyArgvPromptCap(rawUser);
    if (capped.truncated && input.sessionId) {
      logArgvCapTruncation(
        'gemini-cli-user',
        input.sessionId,
        capped.originalBytes,
        Buffer.byteLength(rawUser, 'utf8'),
      );
    }
    const args = ['-p', capped.prompt, '--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    // `--yolo` auto-approves tool calls; reviewer turns keep it so a stray
    // tool call cannot stall headless (edits still forbidden by prompt).
    if (!advisory || reviewerReadOnly) {
      args.push('--yolo');
    }
    return {
      bin: bins.gemini,
      args,
      stdinPrompt: systemWithCorpus,
      systemPromptFileCleanup: null,
    };
  }

  if (engine === 'grok-cli') {
    if (!bins.grok) {
      throw new Error('buildSessionMultiSpawnArgs: grok-cli requires bins.grok');
    }
    // Reviewer corpus cannot fit in `-p` (argv cap). Put system+corpus on
    // stdin and keep `-p` as the short user turn. Advisory chat without a
    // corpus still concatenates into `-p` as before.
    if (reviewCorpus) {
      const rawUser = withTailReminder(userPrompt);
      const capped = applyArgvPromptCap(rawUser);
      if (capped.truncated && input.sessionId) {
        logArgvCapTruncation(
          'grok-cli-user',
          input.sessionId,
          capped.originalBytes,
          rawUser.length,
        );
      }
      const args = ['-p', capped.prompt, '--output-format', 'streaming-json', '--no-auto-update'];
      const grokModel = input.config
        ? resolveGrokSpawnModel(model, input.config)
        : model?.trim() || undefined;
      if (grokModel) {
        args.push('--model', grokModel);
      }
      if (!advisory || reviewerReadOnly) {
        args.push('--always-approve');
      }
      return {
        bin: bins.grok,
        args,
        stdinPrompt: systemWithCorpus,
        systemPromptFileCleanup: null,
      };
    }
    // Grok has no `--system-prompt`; concatenate like Gemini. streaming-json is
    // required because callers (in-session reviewer, multi-agent advisors) feed
    // stdout through createStreamParser('grok-cli'). Omit `--always-approve` on
    // advisory turns to match chat Ask Mode — but Finalize reviewer turns
    // (`reviewerReadOnly`) keep it so auto-approve is available if a tool is used.
    const combined = advisory
      ? `${systemPrompt}\n\n${userPrompt}`
      : withLocalCommitReminder(`${systemPrompt}\n\n${userPrompt}`);
    const rawPrompt = withTailReminder(combined);
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
    if (!advisory || reviewerReadOnly) {
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
    // Codex reads the prompt from stdin (no argv cap), but keep the tail
    // reminder for parity so the reviewer contract reads identically across
    // engines. Ask-mode's read-only sandbox already permits worktree reads.
    const prompt = withTailReminder(`${systemWithCorpus}\n\n${userPrompt}`);
    return { bin: bins.codex, args, stdinPrompt: prompt, systemPromptFileCleanup: null };
  }

  let systemPromptFileCleanup: (() => void) | null = null;
  let claudeSystemPromptArg: string;
  if (input.sessionId) {
    const promptFile = writeSystemPromptFile(systemWithCorpus, input.sessionId);
    systemPromptFileCleanup = promptFile.cleanup;
    claudeSystemPromptArg = promptFile.path;
  } else {
    claudeSystemPromptArg = systemWithCorpus;
  }

  // The claude CLI takes the user prompt as a positional argv argument, so a
  // large prompt — e.g. a fix turn that embeds verbose CI step logs, or a big
  // local-diff reviewer prompt — overflows ARG_MAX and the spawn dies with
  // `spawn E2BIG`. Cap it exactly like the chat path does (the system prompt is
  // already file-backed above, so it's never the culprit).
  const cappedUserPrompt = applyArgvPromptCap(withTailReminder(userPrompt));
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
