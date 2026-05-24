/**
 * Shared CLI-arg helpers for spawning Claude Code (`claude --print …`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why disable native tools that Agent Hub shadows?
 *
 * Agent Hub injects its own protocol blocks into the enriched system prompt
 * (`<agenthub:skill>` for skill loading, `agenthub:ask` fenced blocks for
 * multi-choice user questions, etc.) and documents these as the canonical
 * way to invoke each capability. The prompt also tells the model these
 * replace the equivalent native Claude Code tools.
 *
 * In practice the model still pattern-matches onto the native tools — they
 * sit in the default tool palette and "look reasonable" — and the calls
 * fail because Agent Hub never bridges the native tool's request/response
 * to its own UI:
 *
 *   - Native `Skill` (legacy "Couldnt find tool skill" bug): an agent
 *     invokes `Skill aws-infra` and the CLI returns
 *     `<tool_use_error>Unknown skill: aws-infra</tool_use_error>` because
 *     the Agent-Hub-only skills (`aws-infra`, `design`, `designs`, etc.)
 *     don't exist in Claude Code's bundled registry.
 *
 *   - Native `AskUserQuestion`: an agent invokes the tool with a structured
 *     question payload and Agent Hub renders it as a generic failed tool
 *     call ("AskUserQuestion … ERROR / Answer questions?" red panel) — the
 *     client only knows how to render the `agenthub:ask` event emitted by
 *     `stream-parser.ts`, not the raw native tool_use.
 *
 * Disabling these tools via `--disallowed-tools` makes the documented
 * behavior real: agents have exactly one way to invoke each capability,
 * and the failure modes above stop reaching the user. Bash, WebFetch, and
 * the rest of the tool surface remain untouched.
 *
 * Apply this to every Claude Code spawn that runs an Agent-Hub-enriched
 * system prompt (chat, delegation, room chat, heartbeats/crons via
 * `runClaude`, workflow runner, slack, memory, design).
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Native Claude Code tools that Agent Hub shadows with its own protocol
 * and therefore disables on every enriched spawn. Keep this in lock-step
 * with the `agenthub:*` blocks documented in the enriched system prompt:
 *
 *   - `Skill`             → replaced by `<agenthub:skill>` block
 *   - `AskUserQuestion`   → replaced by `agenthub:ask` fenced block
 */
export const SHADOWED_NATIVE_TOOLS = ['Skill', 'AskUserQuestion'] as const;

/**
 * Args to pass alongside the rest of the Claude CLI invocation in order to
 * disable Claude Code's native tools that Agent Hub already shadows
 * (`Skill`, `AskUserQuestion`, …). Returns a fresh array on each call so
 * callers can safely mutate it.
 *
 * ⚠ Argv ordering caveat
 * ─────────────────────────
 * `--disallowed-tools` is documented as `--disallowed-tools <tools...>` —
 * the trailing `<tools...>` makes it **variadic** in Commander.js (Claude
 * CLI 2.x). A variadic option keeps consuming bare positionals until it
 * hits another `--option` or a `--` end-of-options separator. So this:
 *
 *     --print … --disallowed-tools Skill AskUserQuestion <prompt>
 *
 * is parsed as `disallowed-tools = ["Skill", "AskUserQuestion", "<prompt>"]`
 * with **zero** positional prompt, and the CLI exits with:
 *
 *     Error: Input must be provided either through stdin or as a prompt
 *     argument when using --print
 *
 * Two safe placements for callers:
 *   1. Put another flag (e.g. `--session-id <id>`, `--resume <id>`)
 *      between `disableShadowedNativeToolsArgs()` and the prompt — the
 *      next `--option` terminates variadic consumption.
 *   2. Insert a `--` end-of-options separator immediately before the
 *      positional prompt.
 *
 * Bare-prompt call sites (heartbeat/memory/slack/room-chat/delegation
 * fan-out) use option (2). See those files for the inline comments.
 */
export function disableShadowedNativeToolsArgs(): string[] {
  return ['--disallowed-tools', ...SHADOWED_NATIVE_TOOLS];
}

/**
 * @deprecated Use {@link disableShadowedNativeToolsArgs} instead. Kept as a
 * thin alias so external callers / older patches keep working; the new
 * name better reflects that the helper disables more than just `Skill`.
 */
export const disableNativeSkillToolArgs = disableShadowedNativeToolsArgs;

export type ClaudePermissionMode = 'bypassPermissions' | 'plan' | 'default';

/**
 * Claude Code refuses `--permission-mode bypassPermissions` (and its
 * `--dangerously-skip-permissions` alias) when the Hub process runs as
 * root — common when docker-compose sets `user: root` for docker.sock access.
 * Fall back to `default` so agents still start; operators should prefer
 * running the server as a non-root uid with supplementary group `0` for the
 * socket instead of running the whole container as root.
 */
export function claudePermissionModeForSpawn(
  requested: ClaudePermissionMode = 'bypassPermissions',
): ClaudePermissionMode {
  if (requested !== 'bypassPermissions') return requested;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return 'default';
  }
  return requested;
}
