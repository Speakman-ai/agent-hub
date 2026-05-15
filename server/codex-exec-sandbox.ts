/**
 * Codex `exec` sandbox flags for Agent Hub spawns (interactive chat, rooms,
 * design). Mirrors branches in `chat.ts`; summarized reads remain read-only.
 *
 * See OpenAI docs: https://developers.openai.com/codex/agent-approvals-security
 * (`--dangerously-bypass-approvals-and-sandbox` aliases `--yolo`).
 */
export function appendCodexExecSandboxFlags(
  args: string[],
  opts: { askMode: boolean; dangerBypass: boolean },
): void {
  if (opts.askMode) {
    args.push('--sandbox', 'read-only');
    return;
  }
  if (opts.dangerBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    return;
  }
  args.push('--full-auto');
}
