/**
 * Canonical Agent Hub shipping instructions for dev agents.
 *
 * Used by:
 *   - Open Project wizard analyze prompt (so generated systemPrompts
 *     don't contradict Finalize + session automation)
 *   - POST /api/projects/onboard (appended to dev agent systemPrompts)
 *   - Context file patching on onboard (AGENTS.md shipping section)
 *
 * Runtime chat turns still inject the live finalizeConfigured block from
 * `buildEnrichedPrompt` — this module covers *static* agent/context
 * material written at import time.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Project } from '../types.js';

export const SHIPPING_CONTRACT_MARKER = '<!-- agent-hub-shipping-contract -->';

/**
 * Guidelines appended to ANALYZE_SYSTEM_PROMPT so the one-shot analyzer
 * emits dev personas and context files aligned with Finalize Code Changes.
 */
export const ANALYZE_FINALIZE_SHIPPING_GUIDELINES = `
Guidelines for shipping / PR workflow (CRITICAL — do not contradict Agent Hub):
- Agent Hub dev agents **never** run \`git push\`, \`gh pr create\`, or \`gh pr merge\` during a session when the project is GitHub-connected. The spawn environment blocks direct ship when Finalize is configured; even before \`.agent-hub/ci.yaml\` exists, the human operator owns push/merge via the session UI.
- In the dev agent's \`systemPrompt\`, describe the lifecycle as: implement on a feature branch → run **targeted** tests while iterating → rebase on \`origin/main\` → **commit locally** → stop. Do **not** instruct the agent to open PRs, push, merge, or enable GitHub auto-merge — those steps are handled by **Finalize Code Changes** and per-session automation (Manual / Review / Push / Merge).
- Per-session **Finalize automation** (set in the chat toolbar): Manual (human clicks Finalize + Push), Review Automatically (rebase + in-hub review + ci.yaml checks at session end), Push Automatically (+ auto-push when gates pass), Merge Automatically (+ GitHub native auto-merge on the PR). Assigned kanban cards and autonomous dispatch default to Merge Automatically — the dev agent still only commits locally; the platform runs Finalize after the session ends.
- In \`AGENTS.md\` and \`TOOLS.md\`, document Finalize as the ship path for GitHub-connected code projects. Do **not** document \`gh pr create\` or "push and open a PR" as the dev agent's job.
- In \`SOUL.md\`, prefer "deliver completed, tested commits" over "ship PRs yourself."
- The separate **Reviewer** agent (seeded automatically when GitHub is linked) owns formal GitHub PR reviews; dev agents do not self-review or merge.`;

/** Human-readable block appended to onboarded dev agent systemPrompts. */
export function buildDevAgentShippingContract(project: Project): string {
  const name = project.name || project.id;
  return `${SHIPPING_CONTRACT_MARKER}

## Agent Hub — Shipping (do not override)

You are a **dev** agent for ${name}. Your work ends at a **clean local commit** on the session worktree branch.

**Never during a session:** \`git push\`, \`gh pr create\`, \`gh pr merge\`, or enabling GitHub auto-merge. The spawn environment blocks direct ship when \`.agent-hub/ci.yaml\` exists; the operator uses **Finalize Code Changes** on the session instead.

**Your loop:** branch → implement → run **targeted** tests while fixing → rebase on \`origin/main\` → commit locally → stop. Do not ask permission to push or open a PR.

**After you finish:** the operator (or per-session automation) runs Finalize — rebase, in-hub review, \`.agent-hub/ci.yaml\` checks, then optional auto-push / auto-merge depending on the session's automation level (Manual, Review Automatically, Push Automatically, Merge Automatically). Kanban-assigned and autonomous-dispatch sessions default to **Merge Automatically**; you still only commit — the platform handles Finalize.

**Reviews & merge:** the project's **Reviewer** agent leaves formal GitHub reviews on PRs. You do not merge your own work.`;
}

export function appendDevAgentShippingContract(systemPrompt: string, project: Project): string {
  const body = (systemPrompt || '').trim();
  if (body.includes(SHIPPING_CONTRACT_MARKER)) return body;
  const contract = buildDevAgentShippingContract(project);
  return body ? `${body}\n\n${contract}` : contract;
}

const CONTEXT_SHIPPING_SECTION = `## Shipping & Finalize Code Changes

Dev agents **commit locally only**. Push, PR creation, review gates, and optional auto-merge are handled by Agent Hub **Finalize Code Changes** (when \`.agent-hub/ci.yaml\` is configured) and the session's automation dropdown:

| Level | What runs automatically |
|-------|-------------------------|
| Manual | Nothing — operator clicks Finalize and Push |
| Review Automatically | Finalize (rebase + review + checks) at session end |
| Push Automatically | Finalize + push when gates pass |
| Merge Automatically | Finalize + push + GitHub native auto-merge |

Assigned kanban cards and autonomous dispatch sessions default to **Merge Automatically**. The dev agent never runs \`git push\` or \`gh pr create\` — the spawn environment blocks those when Finalize is configured.

Formal GitHub PR reviews come from the project's **Reviewer** agent, not from dev sessions.`;

/** Ensure onboarded context files mention Finalize instead of legacy self-ship. */
export function patchOnboardContextFilesForShipping(dataDir: string, _project: Project): void {
  const agentsPath = path.join(dataDir, 'AGENTS.md');
  if (!existsSync(agentsPath)) return;
  let content = readFileSync(agentsPath, 'utf-8');
  if (content.includes('## Shipping & Finalize Code Changes')) return;

  // Strip common legacy phrases the analyzer may have emitted.
  content = content
    .replace(/\b(push|open PRs?|gh pr create|create pull requests?)\b[^.\n]*\./gi, (m) => {
      if (/finalize|agent hub/i.test(m)) return m;
      return '';
    })
    .replace(/\n{3,}/g, '\n\n');

  content = `${content.trim()}\n\n${CONTEXT_SHIPPING_SECTION}\n`;
  writeFileSync(agentsPath, content, 'utf-8');
}

/** Apply shipping contract to all dev peers on a freshly onboarded project. */
export function applyOnboardDevAgentShippingContracts(project: Project): boolean {
  if (!project.githubRepo || !project.agents?.length) return false;
  let changed = false;
  for (const agent of project.agents) {
    if (agent.role !== 'dev') continue;
    const next = appendDevAgentShippingContract(agent.systemPrompt || '', project);
    if (next !== agent.systemPrompt) {
      agent.systemPrompt = next;
      changed = true;
    }
  }
  return changed;
}
