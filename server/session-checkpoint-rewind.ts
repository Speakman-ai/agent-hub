import type { SessionRow } from './types.js';

/**
 * File-level checkpoint rewind is implemented by spawning the Claude Code CLI
 * with `--rewind-files`. Other engines do not expose an equivalent hook today.
 */
export function engineSupportsCheckpointRewind(engine: string | null | undefined): boolean {
  return engine === 'claude-code';
}

export type SessionWireRow = SessionRow & { checkpoint_rewind_supported: boolean };

export function enrichSessionForClient(row: SessionRow): SessionWireRow {
  return {
    ...row,
    checkpoint_rewind_supported: engineSupportsCheckpointRewind(row.engine),
  };
}
