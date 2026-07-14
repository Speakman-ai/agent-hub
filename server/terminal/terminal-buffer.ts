/**
 * TerminalBuffer — the server-side scrollback the PTY writes into so its
 * contents outlive any single client.
 *
 * The PTY host owns one of these per session. Every byte the PTY emits is
 * fed in with {@link TerminalBuffer.write}; on (re)connect a viewer gets one
 * serialized snapshot (`serialize()`) that reconstructs the current screen
 * plus scrollback, then a SIGWINCH so full-screen TUIs redraw. This is why
 * the PTY can survive a WS drop / tab sleep: state lives here, not in the
 * browser.
 *
 * The default implementation drives a headless xterm.js terminal
 * (`@xterm/headless`) with the serialize addon (`@xterm/addon-serialize`) —
 * the same parser the web client renders, so a snapshot round-trips exactly.
 * Both are lazily imported so a unit test can inject {@link FakeTerminalBuffer}
 * and never load the real parser; the factory is async to match.
 */

export interface TerminalBuffer {
  /** Feed raw PTY output into the scrollback. */
  write(data: string): void;
  /** Resolve once every queued write has been parsed into the buffer. */
  flush(): Promise<void>;
  /** Serialize the current screen + scrollback to a replayable byte string. */
  serialize(): string;
  /** Adjust the buffer geometry (kept in lockstep with the PTY winsize). */
  resize(cols: number, rows: number): void;
  /** Release the underlying terminal. */
  dispose(): void;
}

export interface TerminalBufferOptions {
  cols?: number;
  rows?: number;
  /** Retained scrollback lines. Default 5000. */
  scrollback?: number;
}

export type TerminalBufferFactory = (opts: TerminalBufferOptions) => Promise<TerminalBuffer>;

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_TERMINAL_SCROLLBACK = 5000;

// Minimal structural shapes of the xterm headless surface we touch. Declared
// here rather than imported so this module type-checks without `@xterm/*`
// present (they are optional at build time, lazily imported at runtime).
interface HeadlessTerminalLike {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
}
interface SerializeAddonLike {
  serialize(): string;
}

/**
 * Real buffer: headless xterm + serialize addon. Non-literal specifiers keep
 * the packages out of the typecheck graph and surface a missing install as
 * an actionable runtime error at first use, not at Hub boot.
 */
export const createXtermTerminalBuffer: TerminalBufferFactory = async (opts) => {
  let TerminalCtor: new (o: object) => HeadlessTerminalLike;
  let SerializeAddonCtor: new () => SerializeAddonLike;
  try {
    const headlessSpecifier = '@xterm/headless';
    const serializeSpecifier = '@xterm/addon-serialize';
    const headless = (await import(headlessSpecifier)) as {
      Terminal: new (o: object) => HeadlessTerminalLike;
    };
    const serialize = (await import(serializeSpecifier)) as {
      SerializeAddon: new () => SerializeAddonLike;
    };
    TerminalCtor = headless.Terminal;
    SerializeAddonCtor = serialize.SerializeAddon;
  } catch (err) {
    throw new Error(
      'TerminalBuffer requires "@xterm/headless" and "@xterm/addon-serialize" ' +
        `(npm install in server/). Import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const term = new TerminalCtor({
    cols: opts.cols ?? DEFAULT_TERMINAL_COLS,
    rows: opts.rows ?? DEFAULT_TERMINAL_ROWS,
    scrollback: opts.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
    // The serialize addon reads SGR/DECRQM state the core marks "proposed".
    allowProposedApi: true,
  });
  const addon = new SerializeAddonCtor();
  term.loadAddon(addon);

  return {
    write: (data) => term.write(data),
    // xterm parses on a write queue; the callback fires once this write (and
    // everything ahead of it) has been applied, making serialize() reflect it.
    flush: () => new Promise<void>((resolve) => term.write('', () => resolve())),
    serialize: () => addon.serialize(),
    resize: (cols, rows) => term.resize(cols, rows),
    dispose: () => term.dispose(),
  };
};

/**
 * Deterministic in-memory buffer for unit tests: appends raw writes and
 * replays them verbatim on serialize. No ANSI parsing — enough to assert
 * snapshot-replay semantics (what was written comes back out) without
 * loading the real terminal.
 */
export class FakeTerminalBuffer implements TerminalBuffer {
  #chunks: string[] = [];
  cols: number;
  rows: number;
  disposed = false;

  constructor(opts: TerminalBufferOptions = {}) {
    this.cols = opts.cols ?? DEFAULT_TERMINAL_COLS;
    this.rows = opts.rows ?? DEFAULT_TERMINAL_ROWS;
  }

  write(data: string): void {
    this.#chunks.push(data);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  serialize(): string {
    return this.#chunks.join('');
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    this.disposed = true;
    this.#chunks = [];
  }
}
