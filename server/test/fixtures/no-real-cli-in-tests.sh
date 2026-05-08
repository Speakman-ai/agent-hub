#!/usr/bin/env bash
# Test guard: this stub stands in for the real claude/cursor/codex/gemini CLI
# during the server test suite. server/test/setup.ts points CLAUDE_BIN /
# CURSOR_BIN / GEMINI_BIN / CODEX_BIN at this script before any test code
# imports server modules.
#
# If a test reaches a real `spawn(claudeBin, ...)` call, it will land here
# instead of the real binary. We exit non-zero with a loud message so the
# offending test fails with a clear pointer to the fix: mock child_process
# (or the wrapper that calls it). See CLAUDE.md "Testing".
#
# Why this exists: an earlier test bug spawned real `claude` children that
# never got reaped — they reparented to init, accumulated to ~20 instances
# holding ~250MB RSS each, and put the prod box into a swap death spiral.
prog="$(basename "$0")"
echo >&2 "[test-guard] $prog was invoked from a vitest run with args: $*"
echo >&2 "[test-guard] Tests must NOT spawn the real claude/cursor/codex/gemini CLI."
echo >&2 "[test-guard] Mock 'child_process' (vi.mock) or the wrapper that calls it"
echo >&2 "[test-guard]   e.g. vi.mock('./heartbeat.js', () => ({ runClaude: vi.fn() }))"
echo >&2 "[test-guard] See CLAUDE.md 'Testing — never spawn real CLI binaries in tests'."
exit 97
