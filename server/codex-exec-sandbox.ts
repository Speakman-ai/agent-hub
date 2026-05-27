import path from 'path';

/**
 * Codex `exec` sandbox flags for Agent Hub spawns (interactive chat, rooms,
 * design). Mirrors branches in `chat.ts`.
 *
 * Sandbox mode names verified against the installed Codex CLI:
 *   `codex exec --help` (codex-cli 0.132.0, 2026-05-26) lists
 *   `[possible values: read-only, workspace-write, danger-full-access]`.
 * OpenAI docs: https://developers.openai.com/codex/cli/reference#codex-exec
 * Security overview: https://developers.openai.com/codex/agent-approvals-security
 *
 * `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) skips sandboxing
 * entirely. `danger-full-access` is the most permissive *sandboxed* mode (no
 * OS-level boundary); it is not the same as the bypass flag.
 */
export interface CodexExecSandboxOpts {
  askMode: boolean;
  dangerBypass: boolean;
  /**
   * Project has Hub-managed AWS IAM Identity Center profiles. When true and
   * `dangerBypass` is false, use `--sandbox danger-full-access` instead of
   * `--full-auto` so nested `aws` can read `AWS_CONFIG_FILE` and
   * `~/.aws/sso/cache` outside the workspace cwd.
   */
  awsSsoEnabled?: boolean;
}

export function appendCodexExecSandboxFlags(args: string[], opts: CodexExecSandboxOpts): void {
  if (opts.askMode) {
    args.push('--sandbox', 'read-only');
    return;
  }
  if (opts.dangerBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    return;
  }
  if (opts.awsSsoEnabled) {
    args.push('--sandbox', 'danger-full-access');
    return;
  }
  args.push('--full-auto');
}

/**
 * Grant Codex read/write to AWS config + SSO token cache dirs that live outside
 * the agent workspace. No-op when paths are missing.
 */
export function appendCodexAwsAccessDirs(
  args: string[],
  env: Pick<NodeJS.ProcessEnv, 'HOME' | 'AWS_CONFIG_FILE'>,
): void {
  const seen = new Set<string>();
  const configFile = env.AWS_CONFIG_FILE?.trim();
  if (configFile) {
    const configDir = path.dirname(configFile);
    if (configDir && configDir !== '/' && configDir !== '.') {
      seen.add(path.resolve(configDir));
    }
  }
  const home = env.HOME?.trim();
  if (home) {
    const awsDir = path.join(home, '.aws');
    if (awsDir && awsDir !== '/' && awsDir !== '.') {
      seen.add(path.resolve(awsDir));
    }
  }
  for (const dir of seen) {
    args.push('--add-dir', dir);
  }
}
