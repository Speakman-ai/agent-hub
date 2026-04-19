# TOOL_ERROR Self-Reporting

When a tool call fails in a way that blocks progress, log a structured line
into the daily notes so patterns are minable across sessions. This is
currently a **convention** (no server-side parser) that feeds future
Session Health tooling — keep the format exact.

## Format

Single line, **pipe-delimited**, six fields:

```
TOOL_ERROR | <ISO timestamp> | <tool name> | <command/action> | <exit code or error type> | <one-line summary>
```

## Example

```
TOOL_ERROR | 2026-04-19T02:45:00Z | Bash | npm test | exit 1 | ENOENT: tsx not found in PATH
```

## When to log

- A tool call exits non-zero and you can't route around it.
- A binary / dependency is missing or a permission is denied.
- You retry the same operation 3+ times — the pattern itself is signal.

## When to skip

- The failure is expected (e.g. `git status` shows no changes, a grep
  returns no matches).
- The tool succeeded but the result was empty.

## Escalation

If the same pattern shows up across 2+ sessions, open a Backlog card tagged
`tool-error` that quotes the structured lines, so the recurring failure
gets triaged instead of repeatedly re-logged. Use `scripts/board.sh create`
to open the card.
