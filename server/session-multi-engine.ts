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
  /**
   * Finalize in-session reviewer turn: read-only, but the reviewer must be
   * able to read files from the worktree (its prompt tells it to read patches
   * that were trimmed from the inline diff). Grok/Gemini/Cursor have no
   * read-only permission mode, so on a plain `advisory` turn their
   * auto-approve flag is dropped and every tool call blocks on an approval
   * that never arrives headless — the reviewer then narrates "I'll read the
   * omitted files" and ends with no verdict. When this is set we keep the
   * auto-approve flag so those reads work; the reviewer system prompt still
   * forbids edits/commits/pushes. Claude's `plan` mode already permits reads,
   * so this only affects the concatenated-argv engines.
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
  // `applyArgvPromptCap`'s tail-keep can never drop it. Reviewer read-only
  // turns need their worktree-read + emit-verdict contract to survive even
  // when a large diff pushes the head off the argv cap.
  const withTailReminder = (prompt: string): string =>
    tailReminder ? `${prompt}\n\n${tailReminder}` : prompt;

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
    // prompt into `-p` (capped) so Cursor still receives the Hub rules.
    const ruleWrite =
      input.cwd != null && input.sessionId
        ? writeCursorHubSessionRule(input.cwd, systemPrompt, input.sessionId)
        : null;
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
      const rawPrompt = withTailReminder(`${systemPrompt}\n\n${userPrompt}`);
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
        // `--force` auto-approves tool calls. Reviewer turns need it to read
        // worktree files even though they are read-only (edits forbidden by
        // the reviewer system prompt); plain advisor turns still omit it.
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
    // `--yolo` auto-approves tool calls; reviewer read-only turns keep it so
    // the reviewer can read worktree files (edits still forbidden by prompt).
    if (!advisory || reviewerReadOnly) {
      args.push('--yolo');
    }
    return {
      bin: bins.gemini,
      args,
      stdinPrompt: systemPrompt,
      systemPromptFileCleanup: null,
    };
  }

  if (engine === 'grok-cli') {
    if (!bins.grok) {
      throw new Error('buildSessionMultiSpawnArgs: grok-cli requires bins.grok');
    }
    // Grok has no `--system-prompt`; concatenate like Gemini. streaming-json is
    // required because callers (in-session reviewer, multi-agent advisors) feed
    // stdout through createStreamParser('grok-cli'). Omit `--always-approve` on
    // advisory turns to match chat Ask Mode — but Finalize reviewer turns
    // (`reviewerReadOnly`) keep it so the reviewer can read worktree files.
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
    // `--always-approve` auto-approves tool calls. Reviewer read-only turns
    // keep it so "read the omitted files from the worktree" actually works;
    // the reviewer system prompt still forbids edits/commits/pushes.
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
    const prompt = withTailReminder(`${systemPrompt}\n\n${userPrompt}`);
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
