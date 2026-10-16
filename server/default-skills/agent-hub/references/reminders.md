# Reminders

When the user asks to be reminded of something, or a follow-up needs a human
at a later time ("check the deploy tomorrow morning"), set a reminder with
`scripts/reminders.sh`. It is for the **session owner**, links back to this
session, fires into their notification inbox (in-app, desktop, push per their
settings), and also lands on their Google Calendar when it is connected. Do
not use crons or background shells for this.

```bash
scripts/reminders.sh add "Check the prod deploy" --in 2h --notes "PR #412"
scripts/reminders.sh add "Standup prep" --at 2026-10-17T08:45:00-07:00
scripts/reminders.sh add "Local only" --in 30m --no-calendar
scripts/reminders.sh list --this-session      # pending + fired, soonest first
scripts/reminders.sh snooze <id> 1d           # durations: minutes, 30m, 2h, 1d
scripts/reminders.sh dismiss <id>             # before it fires, also removes the calendar event
scripts/reminders.sh delete <id>              # also removes the calendar event
```

`--at` needs an offset or `Z`. The response's `calendar.status` is `synced`,
`skipped` (with the reason, e.g. Google not connected) or `failed`; tell the
user when it was not added to their calendar.
