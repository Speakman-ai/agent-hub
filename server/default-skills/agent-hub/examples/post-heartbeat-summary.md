# Example: Post a Cron Summary

**Scenario:** you run as a scheduled project cron (e.g. every 6 hours). At the end
of a run, you want to (a) read the previous thread for continuity, (b) sweep
the board / wiki / deploy status, and (c) leave a structured summary that
future runs can pick up.

Per-agent heartbeats are retired. Use a cron for this kind of sweep.

Back to [README](README.md) · See
[`references/heartbeats-crons.md`](../references/heartbeats-crons.md).

---

## Input (the cron fires automatically)

The cron's configured prompt is something like:

> Every 6 hours: scan the board for stuck cards (In Progress > 24h without a
> PR), check for failing CI on open PRs, and leave a one-line summary.

## Walk-through

### 1. Read the persistent thread to see what the last run said

```bash
scripts/crons.sh thread <cronId> \
  | python3 -c "import json,sys; msgs=json.load(sys.stdin).get('messages',[]); [print(m['created_at'], '-', m['content'][:120]) for m in msgs[-5:]]"
```

Expected output (abbreviated — last five thread entries):

```
2026-04-18T23:00:12Z - Cron: 0 stuck cards, 1 failing PR (#438 — typecheck).
2026-04-19T05:00:04Z - Cron: 1 stuck card (b7e2…), 0 failing PRs.
```

### 2. Gather the board snapshot you need for the summary

```bash
PROJECT_ID=agent-hub scripts/kanban-list.sh --column "In Progress" > /tmp/inprogress.json
PROJECT_ID=agent-hub scripts/kanban-list.sh --column Review      > /tmp/review.json

# Cards sitting in In Progress longer than 24h with no pr_url = stuck
python3 - <<'PY'
import json, datetime as dt
cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
stuck = []
for c in json.load(open("/tmp/inprogress.json")):
    updated = dt.datetime.fromisoformat(c["updated_at"].replace("Z","+00:00"))
    if updated < cutoff and not c.get("pr_url"):
        stuck.append((c["id"], c["title"]))
print(json.dumps(stuck, indent=2))
PY
```

Expected output:

```json
[
  ["b7e2aa31-…", "Auth phase-3 cutover"]
]
```

### 3. Post follow-up actions — comment on the stuck card

```bash
PROJECT_ID=agent-hub scripts/board.sh comment "b7e2aa31-…" '{
  "author": "agent-hub-lead-cron",
  "content": "Cron sweep 2026-04-19T11:00Z: this card has been In Progress >24h with no pr_url. Requesting status from the current assignee."
}'
```

Expected output:

```json
{"id":"…","card_id":"b7e2aa31-…","author":"agent-hub-lead-cron","content":"…","created_at":"2026-04-19T11:00:42.000Z"}
```

### 4. End your turn with the one-line summary

The final assistant message in your cron session becomes the thread entry
that the **next** run will read in step 1. Keep it structured so future runs
can diff against it:

```
Cron 2026-04-19T11:00Z | stuck: 1 (b7e2aa31) | review: 3 | failing PRs: 0 | action: commented on stuck card
```

### 5. (Optional) Log a `TOOL_ERROR` if anything blocked you

If a wrapper returned non-zero and that blocked your run, append a structured
line into your daily notes (see [`references/errors.md`](../references/errors.md)):

```
TOOL_ERROR | 2026-04-19T11:00:42Z | Bash | scripts/board.sh comment | exit 22 | 401 Unauthorized — AGENT_HUB_API_KEY missing
```

---

## Copy-paste checklist

- [x] Read previous thread via `scripts/crons.sh thread <cronId>`
- [x] Sweep relevant board columns with `scripts/kanban-list.sh --column …`
- [x] Comment on any actionable stuck cards
- [x] End with a structured one-line summary (the next run reads it)
- [x] Log `TOOL_ERROR` lines for anything that blocked you

## Gotchas

- **Cron thread is read-only via the API.** You don't POST to the thread
  directly — the thread row is populated from your chat output when the CLI
  closes. Just structure your final message to be the summary.
- **Scheduled runs have short context budgets.** Don't re-read every card's full
  description — filter with `--column` / jq before inspecting.
- **`scripts/crons.sh run <cronId>`** triggers a run *now*; don't call
  this from inside a cron session or you'll recurse.
