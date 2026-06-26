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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex applies `shell_environment_policy` when running model-requested shell
 * commands. Agent Hub already passes `PATH` to the Codex process, but Codex's
 * default tool env can narrow it and drop the bundled skill wrapper directory.
 * Force only the non-secret wrapper location through argv config; credentials
 * such as AGENT_HUB_API_KEY remain env-only so they never appear in process
 * listings.
 */
export function appendCodexShellEnvironmentPolicyArgs(
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
): void {
  const pathValue = env?.PATH?.trim();
  if (pathValue) {
    args.push('-c', `shell_environment_policy.set.PATH=${tomlString(pathValue)}`);
  }
  const skillsDir = env?.AGENT_HUB_SKILLS_DIR?.trim();
  if (skillsDir) {
    args.push('-c', `shell_environment_policy.set.AGENT_HUB_SKILLS_DIR=${tomlString(skillsDir)}`);
  }
}

/**
 * Legacy hook for AWS config dirs outside the agent workspace.
 *
 * Previously pushed `--add-dir` (a Claude Code flag that Codex only accepts on
 * top-level `codex exec`, not `codex exec resume`). Resume turns failed with
 * clap exit code 2: `unexpected argument '--add-dir' found`.
 *
 * AWS access for Codex is handled elsewhere:
 * - `appendCodexExecSandboxFlags` → `--sandbox danger-full-access` when
 *   `awsSsoEnabled` (or full bypass when `dangerBypass`)
 * - spawn env from `mergeProjectAwsSpawnEnv` (`AWS_CONFIG_FILE`, linked
 *   `HOME/.aws` SSO cache)
 *
 * Intentionally a no-op; kept so call sites and tests document the contract.
 */
export function appendCodexAwsAccessDirs(
  _args: string[],
  _env: Pick<NodeJS.ProcessEnv, 'HOME' | 'AWS_CONFIG_FILE'>,
): void {
  // no-op — see docstring
}
