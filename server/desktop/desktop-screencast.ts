/**
 * Live view of an agent's desktop computer for the Agent browser pane.
 *
 * The desktop has no CDP screencast, so a feed polls: every tick it reads the
 * computer's status, and while the computer runs and a viewer is showing the
 * desktop it grabs a PNG through `DesktopRuntime.viewFrame`. Identical frames
 * are not re-sent, so a still desktop costs one screenshot per tick and no
 * bandwidth. Input and agent ops ask for an early frame so the pane reacts
 * without waiting a full tick.
 *
 * Watching never starts a computer and never counts as activity (viewFrame
 * guarantees both), so an open pane can't keep an idle desktop alive.
 *
 * One feed per computer, shared by every pane looking at it (two sessions of
 * the same user, agent and project share one computer).
 */
import type { ScreencastFrame, ScreencastState } from '../browser-screencast.js';
import {
  desktopComputerKeyString,
  subscribeDesktopAgentActivity,
} from './desktop-agent-activity.js';
import { DESKTOP_SCREEN, type DesktopComputerKey, type DesktopRuntime } from './desktop-runtime.js';

export const DESKTOP_SCREENCAST_INTERVAL_MS = 1_000;
/** Delay before the early frame after input, so the screen has time to repaint. */
export const DESKTOP_SCREENCAST_SETTLE_MS = 150;

export interface DesktopScreencastViewer {
  id: string;
  /** False while the pane shows another surface; frames are only captured when some viewer wants them. */
  wantsFrames: () => boolean;
  onFrame: (frame: ScreencastFrame) => void;
  onState: (state: ScreencastState) => void;
}

export interface DesktopScreencastDeps {
  /** The runtime desktops on this host use, or null when none is registered. */
  runtime: () => DesktopRuntime | null;
  intervalMs?: number;
  settleMs?: number;
  logger?: { warn: (message: string) => void };
}

export interface DesktopScreencastHub {
  attach(key: DesktopComputerKey, viewer: DesktopScreencastViewer): () => void;
  /** Capture soon (after the settle delay) instead of at the next tick. */
  requestFrame(key: DesktopComputerKey): void;
  /** Whether the last tick found the computer running. */
  isLive(key: DesktopComputerKey): boolean;
  /** Run one poll on every feed now. Test seam; resolves when all ticks finish. */
  tickAll(): Promise<void>;
  dispose(): void;
}

const WAITING: ScreencastState = { status: 'waiting', url: null, viewport: null, surface: null };

function liveState(): ScreencastState {
  return {
    status: 'live',
    url: null,
    viewport: { width: DESKTOP_SCREEN.width, height: DESKTOP_SCREEN.height },
    surface: 'desktop',
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDesktopScreencastHub(deps: DesktopScreencastDeps): DesktopScreencastHub {
  const intervalMs = deps.intervalMs ?? DESKTOP_SCREENCAST_INTERVAL_MS;
  const settleMs = deps.settleMs ?? DESKTOP_SCREENCAST_SETTLE_MS;
  const logger = deps.logger ?? { warn: (m: string) => console.warn(m) };
  const feeds = new Map<string, Feed>();

  class Feed {
    readonly viewers = new Map<string, DesktopScreencastViewer>();
    live = false;
    lastPng: Buffer | null = null;
    lastFrame: ScreencastFrame | null = null;
    /**
     * Last frame each viewer received. Captures are deduped feed-wide, so a
     * viewer that skipped frames (its pane showed another surface) is caught
     * up from here when it wants frames again, even if the screen is unchanged.
     */
    private readonly delivered = new Map<string, ScreencastFrame>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private ticking: Promise<void> | null = null;
    private again = false;
    private failures = 0;
    private disposed = false;

    constructor(
      readonly id: string,
      readonly key: DesktopComputerKey,
    ) {}

    add(viewer: DesktopScreencastViewer): void {
      this.viewers.set(viewer.id, viewer);
      viewer.onState(this.live ? liveState() : WAITING);
      if (this.live && this.lastFrame) {
        this.delivered.set(viewer.id, this.lastFrame);
        viewer.onFrame(this.lastFrame);
      }
      void this.tick();
    }

    remove(id: string): void {
      this.viewers.delete(id);
      this.delivered.delete(id);
      if (this.viewers.size === 0) this.dispose();
    }

    schedule(ms: number): void {
      if (this.disposed) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, ms);
      (this.timer as { unref?: () => void }).unref?.();
    }

    /** Polls never overlap; a tick asked for mid-poll runs right after it. */
    tick(): Promise<void> {
      if (this.ticking) {
        this.again = true;
        return this.ticking;
      }
      this.ticking = this.poll().finally(() => {
        this.ticking = null;
        if (this.disposed) return;
        if (this.again) {
          this.again = false;
          void this.tick();
        } else {
          this.schedule(intervalMs);
        }
      });
      return this.ticking;
    }

    async idle(): Promise<void> {
      while (this.ticking) await this.ticking;
    }

    private broadcastState(): void {
      const state = this.live ? liveState() : WAITING;
      for (const v of Array.from(this.viewers.values())) {
        try {
          v.onState(state);
        } catch {
          /* viewer gone */
        }
      }
    }

    private setLive(live: boolean): void {
      if (live === this.live) return;
      this.live = live;
      if (!live) {
        this.lastPng = null;
        this.lastFrame = null;
        this.delivered.clear();
      }
      this.broadcastState();
    }

    private async poll(): Promise<void> {
      const runtime = deps.runtime();
      if (!runtime) {
        this.setLive(false);
        return;
      }
      let running = false;
      try {
        running = (await runtime.status(this.key)).state === 'running';
      } catch (err) {
        this.warn(`status failed: ${message(err)}`);
      }
      if (this.disposed) return;
      this.setLive(running);
      if (!running) return;
      const wanted = Array.from(this.viewers.values()).some((v) => v.wantsFrames());
      if (!wanted) return;
      let png: Buffer | null = null;
      try {
        png = await runtime.viewFrame(this.key);
        this.failures = 0;
      } catch (err) {
        this.warn(`frame failed: ${message(err)}`);
        return;
      }
      if (this.disposed) return;
      if (!png) {
        // No capture right now. Only a stop means the desktop went away; a
        // running computer mid-transition just skips this tick.
        let stillRunning = false;
        try {
          stillRunning = (await runtime.status(this.key)).state === 'running';
        } catch {
          stillRunning = this.live;
        }
        if (!this.disposed && !stillRunning) this.setLive(false);
        return;
      }
      if (!this.lastPng || !png.equals(this.lastPng)) {
        this.lastPng = png;
        this.lastFrame = this.frameOf(png);
      }
      const frame = this.lastFrame;
      if (!frame) return;
      for (const v of Array.from(this.viewers.values())) {
        if (!v.wantsFrames() || this.delivered.get(v.id) === frame) continue;
        this.delivered.set(v.id, frame);
        try {
          v.onFrame(frame);
        } catch {
          /* viewer gone */
        }
      }
    }

    private frameOf(png: Buffer): ScreencastFrame {
      return {
        data: png.toString('base64'),
        mime: 'image/png',
        width: DESKTOP_SCREEN.width,
        height: DESKTOP_SCREEN.height,
        viewportWidth: DESKTOP_SCREEN.width,
        viewportHeight: DESKTOP_SCREEN.height,
        url: null,
      };
    }

    private warn(text: string): void {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 60 === 0) {
        logger.warn(`[desktop-screencast] ${text} (x${this.failures})`);
      }
    }

    dispose(): void {
      this.disposed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.viewers.clear();
      this.delivered.clear();
      if (feeds.get(this.id) === this) feeds.delete(this.id);
    }
  }

  const unsubscribeActivity = subscribeDesktopAgentActivity((ev) => {
    if (ev.type === 'ended') hub.requestFrame(ev.key);
  });

  const hub: DesktopScreencastHub = {
    attach(key, viewer) {
      const id = desktopComputerKeyString(key);
      let feed = feeds.get(id);
      if (!feed) {
        feed = new Feed(id, { ...key });
        feeds.set(id, feed);
      }
      const f = feed;
      f.add(viewer);
      return () => f.remove(viewer.id);
    },
    requestFrame(key) {
      feeds.get(desktopComputerKeyString(key))?.schedule(settleMs);
    },
    isLive(key) {
      return feeds.get(desktopComputerKeyString(key))?.live ?? false;
    },
    async tickAll() {
      await Promise.all(
        Array.from(feeds.values()).map(async (f) => {
          await f.tick();
          await f.idle();
        }),
      );
    },
    dispose() {
      unsubscribeActivity();
      for (const f of Array.from(feeds.values())) f.dispose();
      feeds.clear();
    },
  };
  return hub;
}
