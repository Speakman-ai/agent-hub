/**
 * Entrypoint for the bundled runner-agent binary.
 *
 * Bundled (esbuild) into a single self-contained .mjs and run in the fleet task
 * image via the entrypoint's `agent` mode (`node /usr/local/bin/runner-agent.mjs`).
 * Unconditionally starts the agent loop — no import.meta self-exec guard (which
 * is fragile under symlinked paths and double-runs inside a bundle).
 */
import { runAgentMain } from './runner-agent.js';

// The loop only returns when the agent is done (shutdown signal or a draining
// instance); exit even if a stray handle would keep the event loop alive.
runAgentMain()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[runner-agent] fatal:', err);
    process.exit(1);
  });
