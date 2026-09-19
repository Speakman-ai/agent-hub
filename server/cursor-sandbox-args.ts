/**
 * Single source of truth for the `--sandbox` flag on
 * every `cursor-agent` spawn.
 *
 * Cursor runs its shell / file tools inside a bubblewrap sandbox. Inside a
 * typical container the kernel refuses unprivileged user namespaces, so bwrap
 * dies with `No permissions to create a new namespace` and *every* tool call
 * the agent makes fails before it runs. The agent is still alive and still
 * answering — it just cannot read a file, grep, or run a test.
 *
 * That failure mode is invisible from the outside and reads like a model
 * problem. It stalled Finalize in-session review for 17 rounds on this repo:
 * the reviewer was handed a list of omitted patches, every `cat` failed, and it
 * eventually stopped emitting a verdict at all (which the orchestrator scores
 * as `review_failed`).
 *
 * `cursor-agent --sandbox disabled` skips bwrap. We already pass `--force`
 * (auto-approve every tool call) on the same spawns, so the sandbox is not the
 * boundary that keeps a session honest — the SessionEnv adapter and the
 * read-only prompt contract are. This mirrors `codexDangerBypass`, which
 * exists for the identical bubblewrap limitation on Codex.
 *
 * Opt back in with `cursorSandboxBypass: false` (config.json / `PATCH
 * /api/config`) or `AGENT_HUB_CURSOR_SANDBOX_BYPASS=false` on a host whose
 * kernel does allow unprivileged user namespaces.
 */

/** Argv appended to a cursor-agent spawn when the sandbox is bypassed. */
export const CURSOR_SANDBOX_DISABLED_ARGS: readonly string[] = ['--sandbox', 'disabled'];

/**
 * Flags to append to a `cursor-agent` argv for the given bypass setting.
 *
 * `undefined` is treated as the config default (**bypass on**) so a spawn site
 * that has not been threaded the flag still gets a working tool channel rather
 * than silently inheriting the broken sandbox.
 *
 * When the bypass is off we emit nothing rather than `--sandbox enabled`, so
 * the user's own `~/.cursor/cli-config.json` still decides.
 */
export function cursorSandboxArgs(bypass: boolean | null | undefined): string[] {
  return bypass === false ? [] : [...CURSOR_SANDBOX_DISABLED_ARGS];
}
