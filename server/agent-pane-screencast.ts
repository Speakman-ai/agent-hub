/**
 * Feed host for the Agent browser pane: picks between the session's Chromiums
 * (public-web / preview, via browser-screencast.ts) and the agent's desktop
 * computer (desktop/desktop-screencast.ts), and routes human input to
 * whichever is showing.
 *
 * Every viewer is attached to both sources; only the active one's states and
 * frames reach the pane, and the desktop feed captures only while some pane
 * shows it. The active surface, per chat session:
 *   1. the desktop while an agent `computer` op is in flight on it,
 *   2. the browser while an agent browser/preview op is in flight,
 *   3. whichever the agent drove last, if still live,
 *   4. a live browser, then a running desktop.
 *
 * Single-writer: human input on the desktop is refused while an agent op is
 * in flight on that computer (`agent_busy`), the same rule the browser
 * surfaces apply. Desktop input is serialized per chat so a press, a drag
 * and typed text land in the order the human made them.
 */
import { previewBrowserRegistryId } from './browser-screencast-target.js';
import { subscribeBrowserToolOpActivity } from './browser.js';
import {
  attachBrowserScreencastViewer,
  dispatchBrowserViewerInput,
  isAgentDrivingBrowser,
  navigateBrowserViewer,
  type BrowserViewerInput,
  type BrowserViewerInputResult,
  type BrowserViewerNavigateResult,
  type ScreencastFrame,
  type ScreencastState,
  type ScreencastViewer,
} from './browser-screencast.js';
import type { BrowserScreencastFeedHost } from './browser-screencast-websocket.js';
import {
  desktopAgentOpsInFlight,
  desktopComputerKeyString,
  subscribeDesktopAgentActivity,
  type DesktopAgentActivityEvent,
} from './desktop/desktop-agent-activity.js';
import type { DesktopComputerKey, DesktopRuntime } from './desktop/desktop-runtime.js';
import type { DesktopScreencastHub } from './desktop/desktop-screencast.js';
import { DesktopViewerInputTranslator } from './desktop/desktop-viewer-input.js';

export const DESKTOP_AGENT_BUSY_MESSAGE =
  'The agent is using the desktop right now. Wait for its step to finish.';
export const DESKTOP_NOT_RUNNING_MESSAGE = 'The desktop is not running.';
export const DESKTOP_INPUT_NOT_ALLOWED_MESSAGE =
  'Computer access for this session was revoked or is not permitted.';
export const DESKTOP_INPUT_STALE_MESSAGE =
  'Input dropped: the pane stopped showing the desktop before it could run.';
export const DESKTOP_NO_URL_BAR_MESSAGE =
  'The desktop has no URL bar. Open a browser on the desktop and use its address bar.';

type PaneSource = 'browser' | 'desktop';

export interface AgentPaneBrowserSource {
  attach(chatSessionId: string, viewer: ScreencastViewer): () => void;
  input(chatSessionId: string, input: BrowserViewerInput): Promise<BrowserViewerInputResult>;
  navigate(chatSessionId: string, url: string): Promise<BrowserViewerNavigateResult>;
  isAgentDriving(chatSessionId: string): boolean;
  /** Fires with a chat session id whenever an op starts or ends on one of its Chromiums. */
  subscribeActivity(listener: (chatSessionId: string) => void): () => void;
}

export interface AgentPaneDesktopSource {
  hub: DesktopScreencastHub;
  /** The computer this chat session's agent uses, or null (no owner, unknown agent). */
  resolveKey(chatSessionId: string): DesktopComputerKey | null;
  runtime(): DesktopRuntime | null;
  /**
   * Whether the session owner may still drive this computer. Checked before
   * each human input, since access can be revoked while the pane is open.
   */
  inputAllowed?: (chatSessionId: string) => boolean;
  agentOpsInFlight?: (key: DesktopComputerKey) => number;
  subscribeActivity?: (listener: (ev: DesktopAgentActivityEvent) => void) => () => void;
}

export interface AgentPaneScreencastDeps {
  browser?: AgentPaneBrowserSource;
  desktop: AgentPaneDesktopSource;
}

export type AgentPaneFeedHost = BrowserScreencastFeedHost & { dispose(): void };

/** Bound on remembered last-driven entries per surface; oldest are forgotten first. */
const MAX_DRIVE_ENTRIES = 1000;

const PREVIEW_PREFIX = previewBrowserRegistryId('');

export const defaultAgentPaneBrowserSource: AgentPaneBrowserSource = {
  attach: attachBrowserScreencastViewer,
  input: dispatchBrowserViewerInput,
  navigate: navigateBrowserViewer,
  isAgentDriving: isAgentDrivingBrowser,
  subscribeActivity: (listener) =>
    subscribeBrowserToolOpActivity((ev) => {
      listener(ev.id.startsWith(PREVIEW_PREFIX) ? ev.id.slice(PREVIEW_PREFIX.length) : ev.id);
    }),
};

const WAITING: ScreencastState = { status: 'waiting', url: null, viewport: null, surface: null };

interface Entry {
  viewer: ScreencastViewer;
  states: Record<PaneSource, ScreencastState>;
  frames: Record<PaneSource, ScreencastFrame | null>;
  detach: Array<() => void>;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* viewer gone */
  }
}

export function createAgentPaneFeedHost(deps: AgentPaneScreencastDeps): AgentPaneFeedHost {
  const browser = deps.browser ?? defaultAgentPaneBrowserSource;
  const desktop = deps.desktop;
  const desktopOps = desktop.agentOpsInFlight ?? desktopAgentOpsInFlight;
  const subscribeDesktop = desktop.subscribeActivity ?? subscribeDesktopAgentActivity;
  const routers = new Map<string, Router>();

  /**
   * Which surface the agent drove last, per chat (browser) and per computer
   * (desktop), as a shared sequence number so the two compare. Kept at the
   * host, not the router: a router only lives while a pane is open, and the
   * pane must still follow the agent onto the surface it used while nobody
   * was watching.
   */
  let driveSeq = 0;
  const browserDrivenAt = new Map<string, number>();
  const desktopDrivenAt = new Map<string, number>();
  const markDriven = (map: Map<string, number>, id: string) => {
    map.delete(id);
    map.set(id, ++driveSeq);
    if (map.size > MAX_DRIVE_ENTRIES) map.delete(map.keys().next().value as string);
  };
  // Subscribed before any router so a router's recompute sees the mark.
  const hostUnsubs: Array<() => void> = [
    browser.subscribeActivity((chatId) => {
      if (browser.isAgentDriving(chatId)) markDriven(browserDrivenAt, chatId);
    }),
    subscribeDesktop((ev) => {
      if (ev.type === 'entered') markDriven(desktopDrivenAt, desktopComputerKeyString(ev.key));
    }),
  ];

  class Router {
    readonly entries = new Map<string, Entry>();
    active: PaneSource = 'browser';
    /**
     * Gesture state per viewer: two tabs on one chat each have their own
     * pointer, so A's down must not pair with B's up.
     */
    private readonly translators = new Map<string, DesktopViewerInputTranslator>();

    translatorFor(viewerId: string): DesktopViewerInputTranslator {
      let t = this.translators.get(viewerId);
      if (!t) this.translators.set(viewerId, (t = new DesktopViewerInputTranslator()));
      return t;
    }
    inputChain: Promise<unknown> = Promise.resolve();
    /**
     * Bumped whenever desktop input routed earlier may no longer apply: the
     * active surface changed or the router was disposed. Queued input carries
     * the generation it was routed under and is dropped on a mismatch.
     */
    generation = 0;
    disposed = false;
    private readonly unsubs: Array<() => void> = [];

    constructor(
      readonly chatSessionId: string,
      readonly key: DesktopComputerKey | null,
    ) {
      this.unsubs.push(
        browser.subscribeActivity((chatId) => {
          if (chatId !== this.chatSessionId) return;
          this.recompute();
        }),
      );
      const keyId = key ? desktopComputerKeyString(key) : null;
      if (keyId) {
        this.unsubs.push(
          subscribeDesktop((ev) => {
            if (desktopComputerKeyString(ev.key) !== keyId) return;
            if (ev.type === 'entered') this.invalidateHumanInput();
            this.recompute();
          }),
        );
      }
    }

    private lastDriven(): PaneSource | null {
      const b = browserDrivenAt.get(this.chatSessionId) ?? 0;
      const d = this.key ? (desktopDrivenAt.get(desktopComputerKeyString(this.key)) ?? 0) : 0;
      if (b === 0 && d === 0) return null;
      return d > b ? 'desktop' : 'browser';
    }

    private live(source: PaneSource): boolean {
      for (const e of this.entries.values()) if (e.states[source].status === 'live') return true;
      return false;
    }

    private choose(): PaneSource {
      const desktopLive = this.key != null && this.live('desktop');
      const browserLive = this.live('browser');
      if (desktopLive && desktopOps(this.key!) > 0) return 'desktop';
      if (browserLive && browser.isAgentDriving(this.chatSessionId)) return 'browser';
      const lastDriven = this.lastDriven();
      if (lastDriven === 'desktop' && desktopLive) return 'desktop';
      if (lastDriven === 'browser' && browserLive) return 'browser';
      if (browserLive) return 'browser';
      if (desktopLive) return 'desktop';
      return 'browser';
    }

    /**
     * Forget human input captured against the screen as it was: pending
     * presses and wheel remainders, and (via the generation) input still
     * queued. Runs on a surface switch and whenever the agent starts acting
     * on the desktop, since either can change what is under the pointer.
     */
    invalidateHumanInput(): void {
      this.generation += 1;
      this.translators.clear();
    }

    /** Returns true when the active source changed (every viewer was replayed). */
    recompute(): boolean {
      if (this.entries.size === 0) return false;
      const next = this.choose();
      if (next === this.active) return false;
      this.active = next;
      // A press that started on the other surface must not finish here.
      this.invalidateHumanInput();
      if (next === 'desktop' && this.key) desktop.hub.requestFrame(this.key);
      for (const e of this.entries.values()) this.replay(e);
      return true;
    }

    private replay(e: Entry): void {
      const state = e.states[this.active];
      const frame = e.frames[this.active];
      safe(() => e.viewer.onState(state));
      if (state.status === 'live' && frame) safe(() => e.viewer.onFrame(frame));
    }

    add(viewer: ScreencastViewer): () => void {
      const entry: Entry = {
        viewer,
        states: { browser: WAITING, desktop: WAITING },
        frames: { browser: null, desktop: null },
        detach: [],
      };
      this.entries.set(viewer.id, entry);
      const onState = (source: PaneSource) => (s: ScreencastState) => {
        const prev = entry.states[source];
        entry.states[source] = s;
        // A cached frame belongs to the surface it was captured on (web vs
        // preview Chromium); replaying it under another surface's state would
        // show the wrong screen until that surface sends its first frame.
        if (s.status !== 'live' || s.surface !== prev.surface) entry.frames[source] = null;
        if (!this.entries.has(viewer.id)) return;
        if (!this.recompute() && this.active === source) safe(() => viewer.onState(s));
      };
      const onFrame = (source: PaneSource) => (f: ScreencastFrame) => {
        entry.frames[source] = f;
        if (this.entries.has(viewer.id) && this.active === source) safe(() => viewer.onFrame(f));
      };
      entry.detach.push(
        browser.attach(this.chatSessionId, {
          id: viewer.id,
          maxWidth: viewer.maxWidth,
          maxHeight: viewer.maxHeight,
          quality: viewer.quality,
          onState: onState('browser'),
          onFrame: onFrame('browser'),
        }),
      );
      if (this.key) {
        entry.detach.push(
          desktop.hub.attach(this.key, {
            id: viewer.id,
            wantsFrames: () => this.active === 'desktop',
            onState: onState('desktop'),
            onFrame: onFrame('desktop'),
          }),
        );
      }
      // Sources answer attach synchronously; make sure the pane got the
      // active one even when nothing switched.
      this.replay(entry);
      return () => {
        if (!this.entries.delete(viewer.id)) return;
        this.translators.delete(viewer.id);
        for (const d of entry.detach) d();
        if (this.entries.size === 0) this.dispose();
        else this.recompute();
      };
    }

    dispose(): void {
      if (routers.get(this.chatSessionId) === this) routers.delete(this.chatSessionId);
      this.disposed = true;
      this.generation += 1;
      this.translators.clear();
      for (const u of this.unsubs.splice(0)) u();
      for (const e of this.entries.values()) for (const d of e.detach) d();
      this.entries.clear();
    }
  }

  /** Where an input was routed when it was queued. */
  interface DesktopInputRoute {
    router: Router;
    generation: number;
    /** The viewer's attachment at routing time; null when the caller gave no viewer id. */
    entry: Entry | null;
    viewerId: string;
  }

  /**
   * Is the route an input was queued under still the one in effect? Checked
   * before every step that acts, since each await (the queue, status, a
   * previous xdotool call) is a point where the pane can switch or the
   * viewer can leave.
   */
  function routeStillValid(route: DesktopInputRoute): boolean {
    const { router } = route;
    if (router.disposed || routers.get(router.chatSessionId) !== router) return false;
    if (router.generation !== route.generation || router.active !== 'desktop') return false;
    return route.entry === null || router.entries.get(route.viewerId) === route.entry;
  }

  const STALE: BrowserViewerInputResult = {
    ok: false,
    code: 'no_desktop',
    message: DESKTOP_INPUT_STALE_MESSAGE,
  };

  async function desktopInput(
    route: DesktopInputRoute,
    input: BrowserViewerInput,
  ): Promise<BrowserViewerInputResult> {
    const { router } = route;
    if (!routeStillValid(route)) return STALE;
    const key = router.key;
    const runtime = desktop.runtime();
    if (!key || !runtime)
      return { ok: false, code: 'no_desktop', message: DESKTOP_NOT_RUNNING_MESSAGE };
    const allowed = () => desktop.inputAllowed?.(router.chatSessionId) ?? true;
    const NOT_ALLOWED: BrowserViewerInputResult = {
      ok: false,
      code: 'no_desktop',
      message: DESKTOP_INPUT_NOT_ALLOWED_MESSAGE,
    };
    if (!allowed()) return NOT_ALLOWED;
    if (desktopOps(key) > 0) {
      return { ok: false, code: 'agent_busy', message: DESKTOP_AGENT_BUSY_MESSAGE };
    }
    const translated = router.translatorFor(route.viewerId).translate(input);
    if (!translated.ok) return { ok: false, code: 'unsupported', message: translated.message };
    if (translated.events.length === 0) return { ok: true };
    // `input` resumes a stopped computer; a human click must not boot one.
    if ((await runtime.status(key)).state !== 'running') {
      return { ok: false, code: 'no_desktop', message: DESKTOP_NOT_RUNNING_MESSAGE };
    }
    try {
      for (const ev of translated.events) {
        if (!routeStillValid(route)) return STALE;
        if (!allowed()) return NOT_ALLOWED;
        if (desktopOps(key) > 0) {
          return { ok: false, code: 'agent_busy', message: DESKTOP_AGENT_BUSY_MESSAGE };
        }
        await runtime.input(key, ev);
      }
    } catch (err) {
      return {
        ok: false,
        code: 'input_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      desktop.hub.requestFrame(key);
    }
    return { ok: true };
  }

  return {
    attach(chatSessionId, viewer) {
      let router = routers.get(chatSessionId);
      if (!router) {
        let key: DesktopComputerKey | null = null;
        try {
          key = desktop.resolveKey(chatSessionId);
        } catch {
          key = null;
        }
        router = new Router(chatSessionId, key);
        routers.set(chatSessionId, router);
      }
      return router.add(viewer);
    },
    input(chatSessionId, input, viewerId = '') {
      const router = routers.get(chatSessionId);
      if (!router || router.active !== 'desktop') return browser.input(chatSessionId, input);
      const route: DesktopInputRoute = {
        router,
        generation: router.generation,
        entry: viewerId ? (router.entries.get(viewerId) ?? null) : null,
        viewerId,
      };
      // A viewer id the router does not know is not attached: never act for it.
      if (viewerId && !route.entry) return Promise.resolve(STALE);
      const run = router.inputChain.then(() => desktopInput(route, input));
      router.inputChain = run.catch(() => undefined);
      return run;
    },
    async navigate(chatSessionId, url) {
      const router = routers.get(chatSessionId);
      if (router?.active === 'desktop') {
        return { ok: false, code: 'refused', message: DESKTOP_NO_URL_BAR_MESSAGE };
      }
      return browser.navigate(chatSessionId, url);
    },
    dispose() {
      for (const r of Array.from(routers.values())) r.dispose();
      routers.clear();
      for (const u of hostUnsubs.splice(0)) u();
    },
  };
}
