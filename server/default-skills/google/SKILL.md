---
name: google
description: >-
  Read and write the SESSION OWNER's Google Workspace (Calendar, Gmail, Chat,
  Sheets, Drive, Docs)
  through Agent Hub's server-side proxy. The Hub holds the OAuth tokens
  (encrypted at rest) and scopes every call to the user who linked their Google
  account, so wrappers never touch a Google access token. TRIGGER when the user
  asks to read/list/search/create calendar events, read/search/send/label Gmail
  threads or messages, list Google Chat spaces/messages or reply in a Chat
  thread, read/append/update Google Sheets values, or save/link
  files in Google Drive or Google Docs for the
  account linked in Settings → Account → Google. Also trigger on "my calendar",
  "my agenda", "my inbox", "email <person>", "add to the spreadsheet" when an
  Agent Hub Google connection is in view. DO NOT TRIGGER on: third-party
  calendars/mail (Outlook, Apple, Proton, Fastmail); spreadsheet work in
  Excel/CSV files on disk; or generic OAuth/Google-Cloud questions with no
  Workspace data request.
category: integration
version: 1.0.0
keep-coding-instructions: true
---

# Google Workspace

Read and act on the **session owner's** Google Calendar, Gmail, Chat, Sheets,
Drive, and Docs via the Hub proxy under `/api/google/*`. The connection is
per-Hub-user and lives in **Settings → Account → Google**. All calls run
server-side: the Hub fetches a fresh access token for the owner, calls Google,
and returns shaped JSON. **Agents never receive a Google token.**

## Scope of access (v1)

Only **non-sensitive + sensitive** scopes, requested incrementally per surface:

- **Calendar** — read/create/update events (`calendar.events`); list the
  owner's calendars, including ones shared with them (`calendar.calendarlist.readonly`).
  To answer about someone else's calendar ("my wife's calendar"), run
  `google-cal.sh calendars`, pick the matching entry, and pass its id as `--calendar`.
- **Gmail** — read threads, send mail, add/remove labels (`gmail.modify` +
  `gmail.send`). No permanent delete, no `gmail.readonly`.
- **Chat** — list spaces/DMs, read messages, post or reply in a thread
  (`chat.spaces.readonly`, `chat.messages.readonly`, `chat.messages.create`,
  plus optional `chat.memberships.readonly`, which names unnamed DMs and group
  chats by their `participants` in `google-chat.sh spaces`).
  Google Workspace accounts only.
- **Sheets** — read and write values (`spreadsheets`).
- **Drive / Docs** — list/get app-accessible files and save new files
  (`drive.file`). Docs creation uses Drive upload conversion to
  `application/vnd.google-apps.document`; no separate Docs scope is requested.

If a surface's scope was never granted, the proxy returns a `*_scope_required`
error and the wrapper tells you to enable it under Settings → Account → Google.

## Which account answers

The owner can link several Google accounts. Every wrapper except
`google-chat.sh` takes `--account <email|accountId>`, and the ReAct action takes
an `account` field.

- **No `--account`**: the owner's **default** account answers (the one marked
  default in Settings → Account → Google).
- **`--account` names a linked account**: that account answers. Its own scopes
  apply, so one account can have Sheets while another does not.
- **`--account` names anything else**: the call fails with
  `google_account_not_found` (exit 3). It never falls back to the default, so a
  mail meant for `work@` can't go out from `personal@`.

List linked accounts with `scripts/google-accounts.sh` (`--emails` for one per
line, default marked `*`). When the user names a mailbox or calendar ("my work
calendar", "from my personal Gmail"), pass that account explicitly. Proxy
responses carry an `X-Google-Account` header naming the account that served the
call; ReAct observations name it in the heading. Google Chat always uses the
default account.

## Wrappers

The scripts live in this skill's `scripts/` directory (run them by their path
under the skill dir; the absolute skill dir is shown in the **References** index
of this injection). They resolve auth through the agent-hub skill's `ah-api.sh`
and send the acting session id so the proxy attributes the call to the owner.

```bash
# Accounts (default first)
scripts/google-accounts.sh [--emails]

# Any command below (except google-chat.sh) also takes --account <email|accountId>.

# Calendar (`calendars` lists own, shared, and subscribed calendars with their ids;
# `list` reads the primary unless --calendar names one of those ids)
scripts/google-cal.sh calendars
scripts/google-cal.sh list   --from 2026-06-30T00:00:00Z --to 2026-07-01T00:00:00Z [--q TEXT] [--max N] [--calendar ID]
scripts/google-cal.sh create --summary "Launch review" --start 2026-06-30T10:00:00Z --end 2026-06-30T11:00:00Z \
                             [--description T] [--location T] [--timezone TZ] [--attendee a@x.com]… [--calendar ID]
scripts/google-cal.sh update <eventId> [--summary T] [--start ISO] [--end ISO] [--description T] [--calendar ID]

# Gmail
scripts/google-mail.sh threads [--q "is:unread"] [--label INBOX]… [--max N] [--include-spam-trash]
scripts/google-mail.sh thread  <threadId> [--format full|metadata|minimal]
scripts/google-mail.sh send    --to a@x.com… [--cc …] [--bcc …] --subject "…" (--text "…" | --html "…") [--thread <id>]
scripts/google-mail.sh modify  <messageId> [--add-label ID]… [--remove-label ID]…

# Chat (<space> is AAAA or spaces/AAAA; --thread takes spaces/AAAA/threads/BBBB)
scripts/google-chat.sh spaces   [--max N]
scripts/google-chat.sh messages <space> [--thread NAME] [--max N] [--asc]
scripts/google-chat.sh send     <space> --text "…" [--thread NAME]
scripts/google-chat.sh sender-stats [--spaces N] [--max M]   # missing sender-name rate + order check (JSON)

# Sheets
scripts/google-sheets.sh get    <spreadsheetId>
scripts/google-sheets.sh values <spreadsheetId> --range Sheet1!A1:C10 [--major-dimension ROWS|COLUMNS] [--value-render …]
scripts/google-sheets.sh append <spreadsheetId> --range Sheet1!A1 --values '[["Name","Score"],["Alice",42]]' [--input-option USER_ENTERED]
scripts/google-sheets.sh update <spreadsheetId> --range Sheet1!A1:B2 --values '[["a",1],["b",2]]' [--input-option RAW]

# Drive / Docs
scripts/google-drive.sh list [--q TEXT] [--page-size N] [--page-token TOKEN] [--order-by TEXT] [--drive-id ID]
scripts/google-drive.sh get  <fileId>
scripts/google-drive.sh save --file ./report.pdf [--name "Report.pdf"] [--mime-type application/pdf] [--folder-id ID]
scripts/google-drive.sh save --file ./notes.txt --as-doc [--name "Notes"] [--mime-type text/plain]
```

Timestamps are RFC3339 (`2026-06-30T09:00:00-07:00`), or pass `--timezone` with
an offset-less local time. `--values` is a JSON row-major matrix. Read ops need
no extra tooling; create/send/append/update/save build the request body with
`jq`. Drive `save` prints JSON metadata including `webViewLink` when Google
returns one; use that as the shareable link. Drive uploads are capped at 5 MiB.

## Not linked?

If the owner has not linked Google (or the OAuth app isn't configured, or a
surface scope is missing), the wrapper exits **3** and prints a clear pointer to
**Settings → Account → Google**. That is expected — relay it to the user; do not
retry blindly.

## Inline context (ReAct)

For a quick read inside a turn without shelling out, emit a `google` ReAct
action (read-only: calendar, gmail, sheets, or chat for a space's recent messages):

```
<agenthub:react>
{"actions":[{"tool":"google","surface":"calendar","from":"2026-06-30T00:00:00Z","to":"2026-07-01T00:00:00Z"}]}
</agenthub:react>
```

See **[references/usage.md](references/usage.md)** for the full ReAct action
shape and response examples.

## Guardrails

- Never print or log a Google access token — the proxy never returns one.
- A session seeded from the Chat pane carries a `**Chat reference:**` line
  with the space name, plus the thread name when the space keeps replies in
  threads (`supportsThreadReplies`). DMs and group chats have no thread
  reference; `--thread` is ignored there. When the task is done, post the reply
  with `google-chat.sh send <space> --thread <thread>`. From a session it is
  **not sent**: the Hub saves it as a draft (exit 0, `"status":
"pending_approval"`, a notice on stderr) because it goes out under the
  owner's name. The owner approves, edits, or discards it in Agent Hub. Tell
  them the draft is waiting and do not resend it. Only an owner who turned on
  auto-send in the Chat pane gets agent replies posted immediately (`201`).
  When the reply posts, the message's "Sent to agent" chip in the Chat pane
  flips to "Agent replied", so post the reply from the session the message was
  sent to.
- Writes (create event, send mail, Chat messages, modify labels, append/update cells) act on
  the owner's real account. Confirm intent for anything user-visible (an email
  going out, an invite, a destructive overwrite) unless the user already said
  "go ahead".
- Drive and Docs writes create real files in the owner's Google Drive. Confirm
  intent unless the user already asked you to save/link the file.

## See also

- Core skill `agent-hub` — env contract, auth (`ah-api.sh`), error reporting.
- `references/usage.md` — recipes, ReAct action shape, response shapes.
