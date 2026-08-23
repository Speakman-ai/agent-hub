# First-turn prompt contradictions

Working notes for the current experiment. Not a full prompt rewrite.

**Branch:** `prompt/first-turn-contradictions`

## What we are doing

Hub builds a large first-turn system prompt in `buildEnrichedPrompt` (`server/chat.ts`) and feeds it to spawned agents (Claude Code, Cursor, Gemini, Grok). That prompt has grown by patches. Several later lines contradict earlier ones, so the model gets two orders and has to guess.

We are **not** redesigning the whole prompt. We change **one cluster at a time**, check whether agent behavior moves, then stop. If something regresses we need to know which edit did it.

## Why it matters

Typical first-turn stack (simplified):

1. Agent identity + settings `systemPrompt`
2. Project files: `AGENTS.md` / `SOUL.md` / `IDENTITY.md`
3. This repo’s `CLAUDE.md` (~38 KB, first turn only)
4. Skills catalog, ReAct tools, wiki titles, kanban
5. Finalize / git lifecycle / Bias to Action
6. Web search, writing style, ask / credential blocks
7. **Then** the user’s typed message

The user’s text always comes last. Git / Finalize / kanban sit in the **middle**, after `CLAUDE.md`. Models tend to use the start and the end of a long prompt and drop the middle; when two lines conflict, the **later** one often wins.

On **Claude Code**, Hub puts the enriched prompt in `--system-prompt-file` and the user text as the positional prompt. Cursor / Gemini / Grok often get one combined blob. If that blob is too big, the trimmer keeps the **user tail** and drops the **Hub head** (the rules). That is a separate bug; this experiment does not fix it.

## First-cut cluster (already edited)

Do **not** delete Lifecycle or Bias to Action. Do **not** pick a side on Lead wrap-up vs short answers. This cut only removes contradictions that teach the wrong git / ship / tag behavior.

| Topic | Old (contradiction) | New |
|---|---|---|
| Worktree git | `git checkout main && git pull && git checkout -b feature/<name>` plus “safe to branch here” | Stay on this session’s current branch. Do not create or switch. |
| Bias to Action (worktree) | “Implement on a feature branch.” | Implement on this session’s current branch. |
| Finalize on | Last line: “Everything else: **ship it**.” | “Everything else: **do the work**.” Finalize-off still says “ship it.” |
| Close-card example | Shown inside a markdown code block | Naked XML tag, same as skills / ReAct. The host ignores tags wrapped in a code block (except a last-block rescue). |
| Web-search example | Same: ReAct tag inside a code block | Naked XML tag. |
| Existing PRs (Hub git) | `gh pr checks` | `ah-api.sh GET /api/projects/$PROJECT_ID/pulls/<n>`. `gh` is still fine for GitHub Actions logs. Non-Hub GitHub remotes still get `gh pr checks`. |

Non-worktree GitHub sessions still get `checkout -b`. That path is intentional.

Files: `server/chat.ts`, `server/prompt-optimization.test.ts`, `server/finalize/finalize-prompt.test.ts`. Tests: 95 passed. **Not committed** unless we ask.

## How we tested (Cursor mock)

We did not spawn a live Hub session. We gave a subagent the Hub rules plus a lure task (“fix the login button on mobile”) and asked what git / ship / tags it would emit.

**Round 1 — Hub rules only, no `CLAUDE.md`**

| | Old wording | New wording |
|---|---|---|
| Git | `git checkout -b feature/…` | Stay put |
| Push / PR | No (Finalize already won) | No |
| Close-card / web search | Wrapped in a code block | Naked tags |
| Existing Hub PR | (not asked) | `ah-api.sh GET …` |

**Round 2 — same Hub rules, plus this repo’s real `CLAUDE.md` first** (that is the real first-turn order)

| | Old wording + `CLAUDE.md` | New wording + `CLAUDE.md` |
|---|---|---|
| Git | Stay put (`CLAUDE.md` already says never create a branch) | Stay put |
| Push / PR | No | No |
| Close-card / web search | Naked (`CLAUDE.md` already says tags must not be in a code block) | Naked |
| Existing Hub PR | **`gh pr checks`** (later Hub line beat `CLAUDE.md`) | `ah-api.sh GET …` |

Takeaway: **on agent-hub itself**, `CLAUDE.md` already carries most of the git / tag contract. The leftover that still bites is Existing PRs (`gh pr checks` vs Hub API). The first-cut still matters for **other projects**, because Hub injects whatever `CLAUDE.md` lives in that project’s workspace — many will not have this “one session, one branch” section.

Caveat: the mock used a different model than Claude Code, sat in this Cursor workspace (which already injects the same `CLAUDE.md`), and asked “what would you do?” instead of watching real tool calls. It is a filter, not proof.

## Better confirmation: Claude Code the way Hub runs it

Yes, running the same lure tasks in **Claude Code** is a better test — **only if** we run it the way Hub actually spawns Claude Code.

**Do this**

- Throwaway Hub session, Claude Code engine, worktree already on `agent-hub/<agent>/session-<id>`, Finalize on.
- Or dump compiled `buildEnrichedPrompt` and run `claude --system-prompt-file <dump> --print "…"` in a fake worktree already on a session branch.

Watch what it **runs**: `git checkout -b` or not; Hub tags inside a code block or naked; `gh pr checks` vs `ah-api.sh`. One run is not enough; repeat the same task.

**Do not do this**

- Open Claude Code in the Desktop `agent-hub` checkout. That loads Claude Code’s default prompt plus this `CLAUDE.md` and **drops** the Hub lifecycle / close-card / “ship it” blocks we are measuring.
- Add a vitest that spawns the real `claude` binary. Repo rule: tests must never spawn CLI engines.

This confirmation only covers **Claude Code** Hub sessions. Cursor / Gemini / Grok get a different stack.

## Confirmation results — ran it (2026-08-21)

Ran the second bullet above: dumped the compiled `buildEnrichedPrompt` for **old** (HEAD) and **new** (this branch's edits), then `claude --system-prompt-file <dump> -p "<lure>"` in fake worktrees already on `agent-hub/test-agent/session-ab12cd34`, Finalize on. The prompt-only harness (throwaway `server/prompt-dump.test.ts`, reusing `prompt-optimization.test.ts` mocks) never spawned a CLI, so it did not trip the no-real-CLI rule; the `claude` runs were driven from a shell wrapper, not vitest. `server/chat.ts` was restored byte-identical (same `shasum`) after each old dump. Model: `sonnet`. Two serial repeats per condition, `git reset --hard` between them. A stub Hub API on `127.0.0.1:3999` plus a logging `ah-api.sh` stood in for the real host; origins were bogus so nothing could actually push.

Two workspace shapes: **hub** = one of this repo's clones (real `CLAUDE.md` injected first-turn, the real order); **bare** = a tiny login-page repo with **no** `CLAUDE.md` (stands in for the many projects Hub spawns into that lack the "one session, one branch" section).

| Behavior (lure) | old + bare | new + bare | old + hub | new + hub |
|---|---|---|---|---|
| **Git** (fix task) | `git checkout -b feature/…` **2/2** | stay on session branch **2/2** | stay put 2/2 | stay put 2/2 |
| **Existing-PR triage** (PR #3 red) | — | — | `gh pr view 3` **first, 2/2** | `ah-api.sh …/pulls/3` **first, 2/2** |
| **Close-card tag** (redundant card) | **fenced 2/2** (inert form) | naked 2/2 | naked 2/2 | naked 2/2 |
| **Web-search react tag** (best-practice Q) | naked | naked | naked | naked |
| **Push / open PR** (all lures) | never | never | never | never |

Reads:

- **Git branch** — confirmed the round-1 mock live. On **bare** the old `git checkout main && … checkout -b feature/<name>` wins 2/2; the new "stay on this session's current branch" holds 2/2. On **hub** both versions stay put — this repo's `CLAUDE.md` "Git Workflow — One Session, One Branch" already carries it. `git-evidence.log` shows the actual `feature/fix-mobile-login-btn` / `feature/fix-mobile-login-button` checkouts on the two old-bare reps and the session branch everywhere else.
- **Existing-PR triage** — the one contradiction `CLAUDE.md` does **not** rescue, exactly as predicted. Old wording sends the model to `gh pr view 3` first **even with `CLAUDE.md` present** (2/2), then it flails against the bogus GitHub remote and only then falls back to Hub API paths; new wording goes straight to `ah-api.sh GET …/pulls/3` (2/2). This is the highest-value line in the cut for agent-hub itself.
- **Close-card tag** — old + bare emits the block **inside a ``` fence 2/2** (the form the host ignores except the last-block rescue); new + bare emits a naked tag 2/2. On hub, `CLAUDE.md`'s "naked tags vs fenced" section rescues old to naked. (Earlier count looked like "naked=1 fenced=1" on one rep because the model also quoted a naked tag in prose; classifying by the line preceding each opening tag shows the executable block is fenced.)
- **Web-search react tag** — naked in every run that emitted one, no differential; both prompts already carry naked examples up top. Two hub reps answered the best-practice question inline without any react block (web tool was disallowed to force a choice). Edit is neutral-to-positive, no regression.
- **Finalize** — held in all 28 runs: zero `git push`, zero `gh pr create` / `ah-api.sh POST …/pulls`, both versions. The "ship it" → "do the work" edit did not loosen the no-direct-ship contract.

Caveats: `sonnet`, not the exact model a given Hub session pins; stub Hub API returns canned PR/board JSON; the two long code-fix lures sometimes hit the 20-turn cap before committing (equal across versions — task-length noise, not a version effect). Still: this is real Claude Code tool calls, not a "what would you do?" filter, and every first-cut differential reproduced in the predicted direction.

Net: the cut behaves as intended. For **agent-hub itself** the load-bearing line is Existing-PRs (`gh` → `ah-api.sh`); for **other projects** without this `CLAUDE.md`, the git-branch and close-card fixes also bite. Nothing regressed.

## Explicitly not in this cut

- Boxing untrusted ticket / wiki / wizard text (prompt-injection audit — separate).
- Lead Goal/Actions/Evidence/Result vs “keep answers short.”
- Argv trim dropping Hub rules on Cursor / Gemini.
- Rewriting Lifecycle or Bias to Action as a whole.
- Deleting always-on `MEMORY.md`.

## Investigated and closed — `CLAUDE.md` double-inject (2026-08-21)

Picked this as the next cluster; the empirical gate voided it. **There is no double-inject.**

- Canary test confirmed Claude Code loads the cwd `CLAUDE.md` even when `--system-prompt-file` overrides its system prompt (a unique token in a cwd `CLAUDE.md` came back 2/2 with the override on; empty-dir control returned "not found"). So the double-*load* mechanism is real in principle.
- But Hub is not the second loader. `buildEnrichedPrompt` reads `CLAUDE.md` via `contextFilePath → path.join(ahw, 'CLAUDE.md')` (`chat.ts:921`, `project-paths.ts:55`), and **`ahw` is deprecated**: `hydrateProjects` forces it to `getProjectDataDir(id)` = `~/.agent-hub/projects/<id>/`, and the `migrateAhwDirectories` migration strips the field from `projects.json`.
- That data dir never holds a `CLAUDE.md`: `ensureContextFiles` seeds AGENTS/SOUL/USER/TOOLS/MEMORY only, and `find ~/.agent-hub/projects -maxdepth 2 -iname CLAUDE.md` is empty across all project dirs.

So on a real claude-code session the repo `CLAUDE.md` loads exactly once, natively from the worktree; Hub injects nothing. The `ahw` deprecation already killed the duplicate that existed when these notes were first written (when `ahw` could point at the repo checkout, so `ahw/CLAUDE.md == repo CLAUDE.md`).

Side-finding, follow-up PR: the `CLAUDE.md` injection at `chat.ts:921` is **dead for every project** because it joined `ahw` (never seeded). Claude-code hides it by native-loading from the checkout; Cursor / Gemini / Grok get none. Fix: read `sessionWorktreePath || project.cwd`, keep identity files on `ahw`.

Next cluster whenever we pick one: Lead vs writing style — same mock-then-confirm loop.

## User-visible after merge

**Yes.** Spawned agents on the first turn of a worktree session get different git / close-card / web-search / Hub-PR instructions. No UI chrome change.
