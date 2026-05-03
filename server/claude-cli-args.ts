/**
 * Shared CLI-arg helpers for spawning Claude Code (`claude --print …`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why disable the native `Skill` tool?
 *
 * Agent Hub injects its own skill registry into the system prompt under
 * `## Available Skills` (see `buildEnrichedPrompt` in `chat.ts`) and
 * documents `<agenthub:skill>` as the gateway for loading those skills on
 * the next turn. The system prompt explicitly says this **replaces** the
 * native `Skill` tool and works uniformly across claude-code, cursor-agent,
 * and codex.
 *
 * In practice agents would still pattern-match onto the native `Skill` tool
 * — especially for skills that exist in Agent Hub's registry but not in
 * Claude Code's bundled list (e.g. `aws-infra`, `design`, `designs`). Those
 * calls fail with `<tool_use_error>Unknown skill: …</tool_use_error>`,
 * which is confusing, wastes a turn, and surfaces to the user as a broken
 * skill (see bug "Couldnt find tool skill", screenshot showing
 * `Skill aws-infra → Unknown skill: aws-infra`).
 *
 * Disabling the native tool via `--disallowed-tools Skill` makes the
 * documented behavior real: agents have exactly one way to load skills
 * (the `<agenthub:skill>` block), and the names listed under
 * `## Available Skills` are the only ones that work. Bash, WebFetch, and
 * the rest of the tool surface remain untouched.
 *
 * Apply this to every Claude Code spawn that runs an Agent-Hub-enriched
 * system prompt (chat, delegation, room chat, heartbeats/crons via
 * `runClaude`, workflow runner, slack, memory, design).
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Args to pass alongside the rest of the Claude CLI invocation in order to
 * disable Claude Code's native `Skill` tool. Returns a fresh array on each
 * call so callers can safely mutate it.
 *
 * ⚠ Argv ordering caveat
 * ─────────────────────────
 * `--disallowed-tools` is documented as `--disallowed-tools <tools...>` —
 * the trailing `<tools...>` makes it **variadic** in Commander.js (Claude
 * CLI 2.x). A variadic option keeps consuming bare positionals until it
 * hits another `--option` or a `--` end-of-options separator. So this:
 *
 *     --print … --disallowed-tools Skill <prompt>
 *
 * is parsed as `disallowed-tools = ["Skill", "<prompt>"]` with **zero**
 * positional prompt, and the CLI exits with:
 *
 *     Error: Input must be provided either through stdin or as a prompt
 *     argument when using --print
 *
 * Two safe placements for callers:
 *   1. Put another flag (e.g. `--session-id <id>`, `--resume <id>`)
 *      between `disableNativeSkillToolArgs()` and the prompt — the next
 *      `--option` terminates variadic consumption.
 *   2. Insert a `--` end-of-options separator immediately before the
 *      positional prompt.
 *
 * Bare-prompt call sites (heartbeat/memory/slack/room-chat/delegation
 * fan-out) use option (2). See those files for the inline comments.
 */
export function disableNativeSkillToolArgs(): string[] {
  return ['--disallowed-tools', 'Skill'];
}
