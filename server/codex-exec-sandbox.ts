import path from 'path';

/**
 * Codex `exec` sandbox flags for Agent Hub spawns (interactive chat, rooms,
 * design). Mirrors branches in `chat.ts`; summarized reads remain read-only.
 *
 * See OpenAI docs: https://developers.openai.com/codex/agent-approvals-security
 * (`--dangerously-bypass-approvals-and-sandbox` aliases `--yolo`).
 */
export interface CodexExecSandboxOpts {
  askMode: boolean;
  dangerBypass: boolean;
  /**
   * Project has Hub-managed AWS IAM Identity Center profiles. When true and
   * `dangerBypass` is false, use `danger-full-access` + network instead of
   * `--full-auto` so nested `aws` calls can read `AWS_CONFIG_FILE`,
   * `~/.aws/sso/cache`, and reach the SSO endpoint.
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
    args.push('-c', 'sandbox_workspace_write.network_access=true');
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
