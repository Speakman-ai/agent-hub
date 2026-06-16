// Unified one-shot prompt spawner.
//
// Project analyze, heartbeats, crons, and memory reconciliation all
// historically called their own `spawn(claudeBin, …)` block with subtly
// different flag sets. That hardcoded Claude Code as the only engine
// for non-session prompts. This module wraps the per-engine flag
// conventions so callers can do:
//
//     const result = await runOneShotPrompt({
//       engine,         // resolved by `engine-resolver.ts`
//       model,
//       prompt,
//       systemPrompt,   // optional — concatenated into prompt for engines without --system-prompt
//       cwd,
//       timeoutMs,
//       env,
//     });
//
// without caring which CLI is on the other end.
//
// Design notes:
//   - Argument shapes are aligned with `routes/sessions.ts::buildSummarizeSpawnArgs`
//     which already worked for all 4 engines. Cron/heartbeat keep their
//     "bypass permissions" Claude flags via the `claudePermissionMode`
//     option so we don't accidentally regress to a permission prompt
//     that hangs forever in --print mode.
//   - The "detailed" variant returns `{stdout, stderr, code}` for the
//     cron path which displays partial output on failure. The simple
//     variant rejects with a string when the process fails.
//   - We don't try to abstract stream-json output; analyze keeps that
//     concern in its own caller and only uses runOneShotPrompt for the
//     plain-text fallback path.

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { trackChild, killProcessGroup } from './process-groups.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import { shouldPassModelFlag, detectCodexAuthMode } from './codex-auth.js';
import { resolveGrokSpawnModel } from './config.js';
import type { AppConfig } from './types.js';
import { resolveCodexHomeForProbe } from './host-cli-home.js';
import type { SupportedEngine } from './engine-availability.js';

export interface OneShotSpawnInput {
  engine: SupportedEngine;
  model: string;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  timeoutMs: number;
  /**
   * Spawn env. Callers pass the result of `buildSpawnEnv(config)`, with
   * any per-skill-credential merging already applied. We don't mutate it.
   */
  env: NodeJS.ProcessEnv;
  /**
   * For Claude only: the `--permission-mode` flag. Cron/heartbeat use
   * `bypassPermissions` to avoid an interactive prompt; analyze uses the
   * same. Defaults to `bypassPermissions` since one-shot non-interactive
   * prompts always need it.
   */
  claudePermissionMode?: 'bypassPermissions' | 'default';
}

export interface OneShotDetailed {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when `timeoutMs` elapsed and the process was killed. */
  timedOut: boolean;
}

export interface RunOneShotOptions extends OneShotSpawnInput {
  /** When true, return `OneShotDetailed`; when false, return trimmed stdout. */
  detailed?: boolean;
}

/**
 * Build the per-engine `{bin, args}` for a one-shot prompt. Pure — no
 * spawn here so callers can introspect the args (the analyze stream
 * path needs `output-format stream-json`, which is added by the caller
 * before spawning).
 */
export function buildOneShotSpawnArgs(
  input: Omit<OneShotSpawnInput, 'env' | 'cwd' | 'timeoutMs'> & { env?: NodeJS.ProcessEnv },
  cfg: AppConfig,
): { bin: string; args: string[] } {
  const { engine, model, prompt, systemPrompt, claudePermissionMode } = input;
  const trimmedModel = (model || '').trim();

  if (engine === 'cursor-agent') {
    const args = ['--print', '--force'];
    if (trimmedModel) args.push('--model', trimmedModel);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    args.push(prompt);
    return { bin: cfg.cursorBin, args };
  }

  if (engine === 'gemini-cli') {
    // Gemini CLI lacks `--system-prompt`; concatenate.
    const body = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', body];
    if (trimmedModel && trimmedModel !== 'auto') args.push('--model', trimmedModel);
    return { bin: cfg.geminiBin, args };
  }

  if (engine === 'grok-cli') {
    // Grok Build CLI has no `--system-prompt` flag — concatenate into the body
    // like Gemini. `--always-approve` skips interactive approvals so a headless
    // one-shot can't hang; `--no-auto-update` skips background update checks.
    //
    // Output format is intentionally LEFT AT THE DEFAULT (`plain`), NOT
    // `streaming-json`. This is the plain-text one-shot path: `runOneShotPrompt`
    // returns the child's raw stdout (`stdout.trim()`) and never runs it through
    // `createStreamParser` / `normalizeGrok`. Passing `--output-format
    // streaming-json` here would make the returned "answer" a stream of raw
    // JSON-RPC `session/update` lines instead of human text — the same reason
    // the Gemini one-shot branch above stays on plain `-p` output. Only the
    // interactive chat (chat.ts) and Design (design-multi-engine.ts) paths,
    // which DO feed stdout through the parser, request streaming-json.
    const body = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', body, '--no-auto-update', '--always-approve'];
    const grokModel = resolveGrokSpawnModel(trimmedModel, cfg);
    if (grokModel) args.push('--model', grokModel);
    return { bin: cfg.grokBin, args };
  }

  if (engine === 'codex-cli') {
    // No --system-prompt; concatenate. `--skip-git-repo-check` lets us
    // run from any cwd; `--sandbox read-only` is conservative for
    // memory/analyze paths. Crons need write access — they pass their
    // own variant when needed (today none do; future work).
    const body = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args: string[] = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
    // Codex ChatGPT-OAuth mode rejects most --model values; only pass
    // through models on the curated allowlist.
    const codexHome = resolveCodexHomeForProbe(input.env ?? process.env, cfg.dataDir);
    const auth = detectCodexAuthMode(codexHome);
    if (trimmedModel && shouldPassModelFlag(auth.mode, trimmedModel)) {
      args.push('--model', trimmedModel);
    }
    // `?.trim()` guards against an in-memory PATCH config value that wasn't
    // run through the load-time normalizer in `config.ts`. Must come BEFORE
    // the positional body push below.
    const codexProfile = cfg.codexProfile?.trim();
    if (codexProfile) {
      args.push('--profile', codexProfile);
    }
    args.push(body);
    return { bin: cfg.codexBin, args };
  }

  // claude-code (default).
  const args: string[] = ['--print'];
  args.push(
    '--permission-mode',
    claudePermissionModeForSpawn(claudePermissionMode ?? 'bypassPermissions'),
  );
  if (trimmedModel) args.push('--model', trimmedModel);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  args.push(...disableNativeSkillToolArgs());
  // `--` terminates option parsing so the variadic `--disallowed-tools`
  // doesn't swallow the trailing positional prompt (Claude CLI 2.x).
  args.push('--', prompt);
  return { bin: cfg.claudeBin, args };
}

/**
 * Spawn the resolved engine, wait for completion, and return either a
 * trimmed string (default) or a `{stdout, stderr, code, timedOut}`
 * record. Mirrors the historical `runClaude(...)` overloads so callers
 * can swap with minimal diff.
 */
export function runOneShotPrompt(
  input: RunOneShotOptions & { detailed: true },
  cfg: AppConfig,
): Promise<OneShotDetailed>;
export function runOneShotPrompt(input: RunOneShotOptions, cfg: AppConfig): Promise<string>;
export function runOneShotPrompt(
  input: RunOneShotOptions,
  cfg: AppConfig,
): Promise<string | OneShotDetailed> {
  return new Promise((resolve, reject) => {
    if (!existsSync(input.cwd)) {
      return reject(
        new Error(
          `Working directory does not exist: "${input.cwd}" — update the cwd in agent/cron settings`,
        ),
      );
    }

    const { bin, args } = buildOneShotSpawnArgs(input, cfg);

    if (!bin || !existsSync(bin)) {
      return reject(
        new Error(
          `Binary for engine "${input.engine}" not found at "${bin || '(unset)'}". Install the CLI or update Settings.`,
        ),
      );
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc: ChildProcess = spawn(bin, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc, 'SIGTERM');
      const minutes = Math.round(input.timeoutMs / 60000);
      if (input.detailed) {
        reject(
          Object.assign(new Error(`Timed out after ${minutes} minutes`), {
            stdout,
            stderr,
            engine: input.engine,
          }),
        );
      } else {
        reject(new Error(`Timed out after ${minutes} minutes`));
      }
    }, input.timeoutMs);

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected
      if (input.detailed) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code,
          timedOut: false,
        });
        return;
      }
      if (code !== 0 && !stdout) {
        const err = new Error(stderr || `Exited with code ${code}`);
        (err as Error & { engine?: string }).engine = input.engine;
        reject(err);
        return;
      }
      resolve(stdout.trim() || stderr.trim() || '(empty response)');
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      (err as Error & { engine?: string }).engine = input.engine;
      reject(err);
    });
  });
}
