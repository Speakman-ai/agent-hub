/**
 * Serialized saving for the proactive settings form (web and mobile).
 *
 * Each change is a patch naming only the field it changes (`{ areas: { dev:
 * false } }`, `{ quietHours: { start: '23:00' } }`); the server merges nested
 * objects, so a patch never carries other fields' possibly stale values.
 * Patches are sent one at a time in order. The view is the last confirmed
 * server state with every still-pending patch applied on top, so a slow
 * response can never overwrite a newer edit, and a failed patch rolls back
 * only itself.
 */
import type { ServerAgentProactivePrefs } from './serverAgentProactive';

export type ProactivePrefsPatch = Partial<
  Omit<ServerAgentProactivePrefs, 'quietHours' | 'areas'>
> & {
  quietHours?: Partial<ServerAgentProactivePrefs['quietHours']>;
  areas?: Partial<ServerAgentProactivePrefs['areas']>;
};

export function applyProactivePatch(
  prefs: ServerAgentProactivePrefs,
  patch: ProactivePrefsPatch,
): ServerAgentProactivePrefs {
  return {
    ...prefs,
    ...patch,
    quietHours: { ...prefs.quietHours, ...(patch.quietHours ?? {}) },
    areas: { ...prefs.areas, ...(patch.areas ?? {}) },
  } as ServerAgentProactivePrefs;
}

export interface ProactivePrefsQueueState {
  /** What the form shows: confirmed state plus pending patches. */
  prefs: ServerAgentProactivePrefs;
  saving: boolean;
  /** Message from the last failed patch, cleared by the next success. */
  error: string | null;
  /** True after at least one patch was saved successfully. */
  saved: boolean;
}

export class ProactivePrefsQueue {
  private confirmed: ServerAgentProactivePrefs;
  private pending: ProactivePrefsPatch[] = [];
  private busy = false;
  private error: string | null = null;
  private saved = false;

  constructor(
    initial: ServerAgentProactivePrefs,
    private readonly save: (patch: ProactivePrefsPatch) => Promise<ServerAgentProactivePrefs>,
    private readonly onChange: (state: ProactivePrefsQueueState) => void,
  ) {
    this.confirmed = initial;
  }

  state(): ProactivePrefsQueueState {
    return {
      prefs: this.pending.reduce(applyProactivePatch, this.confirmed),
      saving: this.busy,
      error: this.error,
      saved: this.saved,
    };
  }

  enqueue(patch: ProactivePrefsPatch): void {
    this.pending.push(patch);
    this.emit();
    if (!this.busy) void this.drain();
  }

  /** Resolves once every queued patch has been sent (tests, unmount). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 0));
  }

  private emit(): void {
    this.onChange(this.state());
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.pending.length > 0) {
      const patch = this.pending[0];
      try {
        this.confirmed = await this.save(patch);
        this.error = null;
        this.saved = true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not save.';
      }
      this.pending.shift();
      if (this.pending.length === 0) this.busy = false;
      this.emit();
    }
    this.busy = false;
  }
}
