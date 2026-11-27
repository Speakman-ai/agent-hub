/**
 * Session forward card guidance for ordinary (Build / chat) sessions.
 *
 * Hub, Consult and Orchestrate preambles already tell the model to start
 * another session through an `agenthub:forward` card. A plain Build session
 * got no such guidance, so "forward this" / "spin up a new session for X"
 * made the agent run `sessions.sh dispatch` or the forward API itself, which
 * starts the session without the person ever seeing the card. Sent on every
 * turn: the request can come at any point in a session.
 */
export function buildSessionForwardGuidance(args: {
  projectId?: string | null;
  agentId?: string | null;
  workflow?: boolean;
}): string {
  const projectId = args.projectId || '<project id>';
  const agentId = args.agentId || '<this agent id>';
  const modeLine = args.workflow
    ? 'This is a **workflow** project with no build levels, so set `"mode": "consult"`.'
    : '`mode` is only your suggestion: Build (`manual`), Build and Review (`review`), Build and Push (`push`), or Auto Merge (`merge`). The person can change it on the card. Do not ask the level with `agenthub:ask`.';
  return [
    '## Starting Another Session (Session forward card)',
    'When the user asks you to forward this session, spin up / start / open a new session, hand work to another session or agent, or split work off into its own session, do **not** run `sessions.sh dispatch`, call the sessions/forward API, or start it any other way yourself. Write one short sentence, emit **one** fenced `agenthub:forward` block, and stop. Web, mobile and Electron render it as a Session forward card; the person reviews the prompt, picks the level, and presses **Session forward**, which starts the session as them.',
    '',
    '```agenthub:forward',
    '{',
    `  "projectId": "${projectId}",`,
    `  "agentId": "${agentId}",`,
    '  "name": "short title",',
    '  "summary": "what the new session will do",',
    '  "prompt": "the request plus the context and decisions from this session the new one needs",',
    '  "mode": "manual"',
    '}',
    '```',
    '',
    `- \`agentId\` defaults to this agent (\`${agentId}\`). Use another project agent only when the user names one (\`server.sh agents\` lists them).`,
    '- The new session does not see this transcript. Make `prompt` self-contained: what to do, relevant files, findings, and decisions already made here.',
    `- ${modeLine}`,
    '- Use the `<agenthub:forward>…</agenthub:forward>` XML form instead of a fence when the prompt itself contains a code fence.',
    '- Several sessions at once: confirm the split with `agenthub:ask` first, then emit one card per session.',
    '- `sessions.sh dispatch` is only for unattended runs (background agents, autonomous dispatch) where nobody is there to press the button.',
  ].join('\n');
}
