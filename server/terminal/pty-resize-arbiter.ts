/**
 * PtyResizeArbiter — one resize authority across all viewers of a shared PTY.
 *
 * A single PTY master has exactly one winsize. When two clients render the
 * same shell at different geometries, honoring either one blindly makes the
 * other viewer's screen tear, and letting each viewer drive TIOCSWINSZ
 * thrashes SIGWINCH. The shared-pty decision adopts tmux's
 * `window-size smallest`: the effective size is the per-axis minimum across
 * every attached viewer (min cols, min rows, computed independently), so the
 * rendered region always fits inside every client.
 *
 * Pure and synchronous — the PtySession owns the side effect of pushing the
 * computed size onto the real PTY.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Terminals below 1×1 are meaningless; clamp so a bogus report can't wedge. */
const MIN_DIMENSION = 1;

function sanitizeDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_DIMENSION;
  const floored = Math.floor(value);
  return floored < MIN_DIMENSION ? MIN_DIMENSION : floored;
}

export class PtyResizeArbiter {
  readonly #viewers = new Map<string, TerminalSize>();

  /** Number of viewers currently contributing to the arbitration. */
  get viewerCount(): number {
    return this.#viewers.size;
  }

  has(viewerId: string): boolean {
    return this.#viewers.has(viewerId);
  }

  /**
   * Record (or update) a viewer's reported geometry. Non-finite or
   * sub-1 values are clamped to 1 rather than rejected, so a malformed
   * client report degrades gracefully instead of throwing mid-attach.
   */
  set(viewerId: string, size: TerminalSize): void {
    this.#viewers.set(viewerId, {
      cols: sanitizeDimension(size.cols),
      rows: sanitizeDimension(size.rows),
    });
  }

  /** Drop a viewer (on detach). Returns true if it was present. */
  remove(viewerId: string): boolean {
    return this.#viewers.delete(viewerId);
  }

  /**
   * The size the PTY should adopt: the per-axis minimum across all viewers,
   * or `null` when no viewer is attached (the session keeps the PTY at its
   * last geometry rather than resizing to a default).
   */
  effectiveSize(): TerminalSize | null {
    if (this.#viewers.size === 0) return null;
    let cols = Infinity;
    let rows = Infinity;
    for (const size of this.#viewers.values()) {
      if (size.cols < cols) cols = size.cols;
      if (size.rows < rows) rows = size.rows;
    }
    return { cols, rows };
  }
}
