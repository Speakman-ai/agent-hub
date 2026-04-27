/**
 * Delegation gate — operator-controlled disable switch for `<delegate>`.
 *
 * The user-facing product knob is `Agent.delegationEnabled` (per-agent
 * boolean, default `undefined`/`true` = delegation allowed). When the lead
 * agent has it explicitly set to `false`, the server skips dispatching
 * sub-agent sessions even when a well-formed `<delegate>` block is emitted,
 * and instead surfaces an in-chat nudge so the lead does the work inline.
 *
 * Why per-agent (not per-project / global): the user request that motivated
 * this gate was specifically "stop the lead from delegating" — the operator
 * wants to keep the same agent roster, the same project, and the same chat
 * UX, just have the lead complete work itself. A per-agent flag matches
 * that ask precisely. Per-project / global toggles would force the
 * operator to choose between "all leads delegate" and "no lead delegates",
 * which is strictly less expressive.
 *
 * Default-off semantics matter: existing agents have no `delegationEnabled`
 * field set, and we MUST preserve normal delegation for them — so the only
 * value that disables the gate is the explicit boolean `false`.
 *
 * See wiki page "Delegation Gate — Per-Agent <delegate> Disable Switch".
 */

import type { Agent } from './types.js';

/**
 * Returns `true` when the agent's `delegationEnabled` field is explicitly
 * `false`. Any other value (including `undefined`, `true`, or
 * non-boolean garbage) leaves delegation enabled.
 *
 * The strict `=== false` check is deliberate: the worst failure mode here
 * is silently disabling delegation on an agent that never opted in, which
 * would make sub-agents stop spawning across the whole installation. By
 * keying off the exact literal `false`, any DB/JSON corruption that leaves
 * the field as `null`, `0`, or a string defaults safely to enabled.
 */
export function isDelegationDisabledForAgent(agent: Pick<Agent, 'delegationEnabled'>): boolean {
  return agent.delegationEnabled === false;
}
