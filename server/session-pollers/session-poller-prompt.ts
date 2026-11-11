/**
 * System prompt guidance for `agenthub:poller` blocks. Sent on every turn:
 * the request ("every 30 min check dev…") can come at any point in a session,
 * and a capability the model can't see on turn five is one it won't use.
 */
export const SESSION_POLLER_PROMPT_GUIDANCE = `## Session Pollers (recurring checks)
When the user asks you to repeat a check on a schedule in this session ("every 30 min check dev and see if tickets are coming through", "poll the deploy every 5 minutes for the next hour", "...until tomorrow at 9am"), do **not** loop, sleep, start a background shell, use your CLI's own scheduler (CronCreate, ScheduleWakeup, /loop), or create a project cron with \`crons.sh\` / the \`agent-hub-heartbeats-crons\` skill. Emit a **fenced** \`agenthub:poller\` block (triple backticks, not an XML tag). Web, mobile and Electron render it as a card with the schedule pre-filled; the user can adjust it and clicks Start. Agent Hub then wakes this session at each interval with the task, and you report what you found.

\`\`\`agenthub:poller
{"pollerId":"dev-tickets","task":"Check dev and report whether new tickets are coming through.","intervalMinutes":30,"durationMinutes":120,"notifyEachRun":false,"notifyOnComplete":true}
\`\`\`

- \`pollerId\`: a short slug unique within this session.
- \`task\`: what each run should check, written as an instruction you will receive later. Make it self-contained (environment, URL, what counts as a change).
- \`intervalMinutes\` and \`durationMinutes\`: whole minutes greater than 0. Fill in what the user said; omit a value they did not give and the card will ask.
- When the user names an end time, send \`until\` instead of \`durationMinutes\` and copy their words in 24-hour form: "until tomorrow at 9am" → \`"until":"tomorrow 09:00"\`, "until 5pm" → \`"until":"17:00"\` (the next 17:00), "until today at 6" → \`"until":"today 18:00"\`. Do not convert to UTC or a date yourself; the card resolves it in the user's own timezone and shows the resulting duration.
- \`notifyEachRun\` (default false) and \`notifyOnComplete\` (default true): set them from what the user asked for ("ping me each time", "let me know when it's done").

A project cron is only right when the user explicitly asks for a project cron or a standing job that runs on its own with no session; a request phrased in this chat ("every 30 min run this check again") is a poller even when each run should open forward sessions or cards. Keep the message around the block to one short line. Nothing runs until the user clicks Start. Each run arrives as a "Scheduled poller check-in" message: do the check and answer briefly with what changed since the last run.`;
