/**
 * Host-enforced approval gate for the `computer` tool (SPEC-4 applied to the
 * desktop). It reuses the browser profile of the same (user, agent, project)
 * key: its allow / ask / block policies and its remembered approval rules.
 *
 * Every op that sends input (click, double_click, type, key, scroll, drag,
 * exec) is resolved to the targets it lands on before any decision, and
 * resolving sends no input of its own. A target is the app (the topmost
 * window at the op's coordinates, found by a passive hit test, for pointer
 * ops; the focused window for keyboard ops; the `shell` app for exec) plus, when that app is the desktop
 * Chromium, the site of its visible tab. Apps are keyed as pseudo-domains
 * (`chromium.desktop.invalid`, see shared/utils/desktopAppPolicy.ts) and
 * sites by hostname, so one site policy covers the Agent browser and the
 * desktop alike, and an always-allow rule saved on either surface applies
 * to both.
 *
 *   - block on any app or site a target touches refuses the op.
 *   - ask raises an approval unless an always-allow rule for that domain and
 *     op exists; a require rule always asks.
 *   - A shell (the exec op, or a terminal window identified by class or
 *     process) can reach any app or site, so while any policy is set it asks
 *     unless the human trusts it explicitly: an Allow policy on
 *     `desktop:shell` or a remembered always-allow rule.
 *   - An exec command matching the configurable deny list always asks, even
 *     on an allowed shell, and the answer is never remembered.
 *
 * Whether a window is a browser or a terminal comes from its process
 * executable as well as its class, and a window whose process cannot be
 * read is an unknown site rather than a non-browser. A tab's sites are the
 * effective origins of every frame in it, read from each document in an
 * isolated world (see CDP_FRAME_TREE_SCRIPT), never inferred from URLs,
 * and apply only to windows of the process serving DevTools; any other
 * browser window, and any tab whose frames Chromium does not fully report,
 * is an unknown site.
 *
 * Trust boundary: window class, title and _NET_WM_PID are set by the
 * programs on the desktop, so only a program already running there could
 * forge them. Starting a program takes shell input, which asks while any
 * policy is set unless the human trusts the shell.
 *
 * The same resolve-then-decide step runs again after every approval, from a
 * fresh read of the profile, so nothing decided before a wait is trusted
 * after it. Fails closed: an unreadable policy refuses the op, and a target
 * the host cannot identify (unknown window, tab URL unavailable) asks
 * whenever something it might be is gated.
 */
import {
  DESKTOP_CHROMIUM_CDP_PORT,
  DESKTOP_DISPLAY,
  type DesktopExecResult,
} from './desktop-runtime.js';
import type { DesktopOp } from './control-daemon.js';
import {
  DESKTOP_APP_DOMAIN_SUFFIX,
  DESKTOP_SHELL_APP,
  DESKTOP_UNKNOWN_APP,
  desktopAppDomain,
  formatPolicyDomain,
  normalizeDesktopAppName,
} from '../../shared/utils/desktopAppPolicy.js';
import { getBrowserProfile } from '../browser-profiles-store.js';
import { normalizeBrowserLoginDomain } from '../browser-login-handoff.js';
import { compileExecApprovalPatterns, matchExecApprovalPattern } from './computer-exec-patterns.js';
import {
  decideBrowserDomainGate,
  listBrowserDomainPolicies,
  type BrowserGateDecision,
} from '../browser-domain-policy.js';
import { findApprovalRule, hostWithinDomain } from '../approvals-store.js';
import { getOrgsDb } from '../orgs.js';
import {
  requestHostApproval,
  type ApprovalContext,
  type ApprovalDeps,
} from '../approval-requests.js';

/** Computer ops that change something on the desktop and so pass the gate. */
/**
 * Every op that sends input to the desktop. Scroll is included: wheel events
 * change select and number controls and run arbitrary page and app handlers,
 * so they are not read-only. Only screenshot, wait and cursor_position, which
 * send no input, pass ungated.
 */
export const GATED_COMPUTER_OPS = [
  'click',
  'double_click',
  'type',
  'key',
  'scroll',
  'drag',
  'exec',
] as const;
export type GatedComputerOp = (typeof GATED_COMPUTER_OPS)[number];

export function isGatedComputerOp(op: string): op is GatedComputerOp {
  return (GATED_COMPUTER_OPS as readonly string[]).includes(op);
}

/** WM_CLASS names of the desktop's Chromium-family browser windows. */
/**
 * Executable names of browsers. A window whose process runs one of these is
 * a browser whatever WM_CLASS it claims. Only the desktop Chromium exposes
 * its tabs, so any other browser always reads as an unknown site.
 */
const BROWSER_EXE_RE =
  /^(chrome|chromium|chromium-browser|google-chrome|chrome-wrapper|firefox|firefox-esr|firefox-bin|epiphany|epiphany-browser|falkon|midori|qutebrowser|brave|brave-browser|vivaldi|vivaldi-bin|opera|msedge|microsoft-edge)(-stable|-beta|-dev|-unstable)?$/;

function exeBase(path: string): string {
  return (
    path
      .trim()
      .replace(/ \(deleted\)$/, '')
      .split('/')
      .pop() ?? ''
  );
}

export function isBrowserExecutable(path: string): boolean {
  return BROWSER_EXE_RE.test(exeBase(path));
}

/** Terminal emulators, by executable name or WM_CLASS: typing into one runs commands. */
const TERMINAL_RE =
  /^(x-terminal-emulator|xterm|uxterm|lxterm|gnome-terminal|gnome-terminal-server|konsole|urxvt|rxvt|rxvt-unicode|alacritty|kitty|lxterminal|xfce4-terminal|tilix|terminator|st|st-256color|foot|wezterm|wezterm-gui|sakura|qterminal|mate-terminal|terminology)$/;

export function isTerminal(app: string, exe: string | null): boolean {
  return TERMINAL_RE.test(app) || (exe !== null && TERMINAL_RE.test(exeBase(exe)));
}

export const DESKTOP_BROWSER_APPS: ReadonlySet<string> = new Set([
  'chromium',
  'chromium-browser',
  'google-chrome',
]);

/** What one point (or the focused window) of an op lands on. */
export interface DesktopTarget {
  /** App key; `unknown` when no client window could be read. */
  app: string;
  /**
   * Every site the window may be acting as. Always kept, even when the list
   * is incomplete: policies on these hosts (blocks first) apply regardless.
   */
  hosts: string[];
  /** The window may also be acting as sites not in `hosts`. */
  siteUnknown: boolean;
  /**
   * Input here runs shell commands: the exec op, or a terminal window. A
   * shell can reach any app or site, so it is checked as `desktop:shell` too.
   */
  shell: boolean;
}

/** Stable identity of a target, used to compare before / after a wait. */
export function desktopTargetKey(t: DesktopTarget): string {
  return `${t.app}|${[...t.hosts].sort().join(',')}|${t.siteUnknown ? '?' : ''}`;
}

/** Where on screen an op lands; null for keyboard ops (they go to the focused window). */
function opPoints(op: DesktopOp): Array<{ x: number; y: number }> | null {
  switch (op.op) {
    case 'click':
    case 'double_click':
    case 'scroll':
      return [{ x: op.x, y: op.y }];
    case 'drag':
      return [
        { x: op.x, y: op.y },
        { x: op.toX, y: op.toY },
      ];
    default:
      return null;
  }
}

function targetCount(op: DesktopOp): number {
  return opPoints(op)?.length ?? 1;
}

/**
 * Node script run inside the desktop. It lists the DevTools targets and, for
 * every page and out-of-process iframe, reads the effective origin of every
 * frame in it, as the document itself has it (`self.origin`), evaluated in a
 * fresh isolated world (`Page.createIsolatedWorld`) so page script cannot
 * override the value. That is the origin an about:blank popup inherited from
 * its opener. `Page.getFrameTree`'s `securityOrigin` is not used: Chromium
 * derives it from the frame URL and reports such a popup as opaque.
 *
 * Prints one JSON array of targets with `frameOrigins`: one entry per frame,
 * `''` for a frame whose origin could not be read (unknown), and the whole
 * list null when the frame tree itself could not be read. A frame rendered
 * by another process is skipped when it has its own iframe target, which
 * reports it. Node's WebSocket sends no Origin header, which DevTools
 * accepts without --remote-allow-origins. AGENT_HUB_CDP_PORT overrides the
 * port (tests only).
 */
export const CDP_FRAME_TREE_SCRIPT = `
const port = Number(process.env.AGENT_HUB_CDP_PORT || ${DESKTOP_CHROMIUM_CDP_PORT});
let printed = false;
const print = (v) => { if (!printed) { printed = true; process.stdout.write(JSON.stringify(v)); } process.exit(0); };
setTimeout(() => print(null), 6000).unref();
const connect = (wsUrl) => new Promise((resolve) => {
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { resolve(null); return; }
  let next = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((res) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); res(null); }, 3000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    try { ws.send(JSON.stringify({ id, method, params: params || {} })); } catch { pending.delete(id); clearTimeout(timer); res(null); }
  });
  ws.onopen = () => resolve({ call, close: () => { try { ws.close(); } catch {} } });
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(String(e.data)); } catch { return; }
    const done = m && pending.get(m.id);
    if (done) { pending.delete(m.id); done(m); }
  };
  ws.onerror = () => resolve(null);
});
const frameIds = (tree, acc) => {
  if (!tree || !tree.frame || typeof tree.frame.id !== 'string') return false;
  acc.push(tree.frame.id);
  return (tree.childFrames || []).every((c) => frameIds(c, acc));
};
const targetOrigins = async (wsUrl, ownTargets) => {
  const s = await connect(wsUrl);
  if (!s) return null;
  try {
    const tree = await s.call('Page.getFrameTree');
    const ids = [];
    if (!tree || !tree.result || !frameIds(tree.result.frameTree, ids)) return null;
    const origins = [];
    for (const frameId of ids) {
      const world = await s.call('Page.createIsolatedWorld', { frameId, worldName: 'agent-hub-approval-gate' });
      const ctx = world && world.result && world.result.executionContextId;
      if (!ctx) {
        if (!ownTargets.has(frameId)) origins.push('');
        continue;
      }
      const r = await s.call('Runtime.evaluate', { contextId: ctx, expression: 'self.origin', returnByValue: true });
      const v = r && r.result && r.result.result && r.result.result.value;
      origins.push(typeof v === 'string' ? v : '');
    }
    return origins;
  } finally {
    s.close();
  }
};
(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const targets = list.filter((t) => t && (t.type === 'page' || t.type === 'iframe'));
  const ownTargets = new Set(targets.filter((t) => t.type === 'iframe').map((t) => t.id));
  const origins = await Promise.all(
    targets.map((t) => (typeof t.webSocketDebuggerUrl === 'string' ? targetOrigins(t.webSocketDebuggerUrl, ownTargets) : null)),
  );
  print(targets.map((t, i) => ({
    id: t.id, type: t.type, title: t.title, url: t.url, parentId: t.parentId || null, frameOrigins: origins[i],
  })));
})().catch(() => print(null));
`;

/**
 * Shell script gathering what the gate needs to know about where the op
 * lands, without sending any input: no pointer movement, no key events. It
 * only reads X properties and window geometry, so nothing on the desktop
 * sees hover, enter or move events before the op is cleared.
 *
 * Output, keyed by window id so nothing pairs by position:
 *   - `STACK:` the window manager's client list, bottom to top
 *     (_NET_CLIENT_LIST_STACKING), for pointer ops.
 *   - `GEOM@<id>:` x y width height viewable override-redirect, and
 *     `EXT@<id>:` frame extents, for every client and every top-level window.
 *   - `FOCUS:` the focused window, for keyboard ops.
 *   - `APP@`, `TITLE@`, `PID@`, `EXE@<id>:` class, title, process and its
 *     executable for each client (and the focused window).
 *   - With sites, `CDP:` the desktop Chromium's targets with their frame
 *     origins (CDP_FRAME_TREE_SCRIPT) and `CDPPID:` the process serving them.
 *
 * resolveProbeWindows does the hit test in TypeScript. The UTF-8 locale
 * makes xprop print titles as UTF-8 rather than escapes.
 */
export function buildTargetProbeCommand(op: DesktopOp, withSites: boolean): string | null {
  if (op.op !== 'type' && op.op !== 'key' && !opPoints(op)) return null;
  const points = opPoints(op);
  const lines = [
    `export DISPLAY=${DESKTOP_DISPLAY} LC_ALL=C.UTF-8`,
    'seen=" "',
    'describe() { case "$seen" in *" $1 "*) return ;; esac; seen="$seen$1 "; echo "APP@$1:$(xprop -id "$1" WM_CLASS 2>/dev/null)"; echo "TITLE@$1:$(xprop -id "$1" _NET_WM_NAME 2>/dev/null)"; pid=$(xprop -id "$1" _NET_WM_PID 2>/dev/null | sed -n "s/.* = \\([0-9][0-9]*\\).*/\\1/p"); echo "PID@$1:$pid"; echo "EXE@$1:$( [ -n "$pid" ] && readlink "/proc/$pid/exe" 2>/dev/null )"; }',
    `geom() { xwininfo -id "$1" 2>/dev/null | awk -v id="$1" '/Absolute upper-left X:/ { x = $NF } /Absolute upper-left Y:/ { y = $NF } /^ *Width:/ { w = $NF } /^ *Height:/ { h = $NF } /Map State:/ { v = ($NF == "IsViewable") ? 1 : 0 } /Override Redirect State:/ { o = ($NF == "yes") ? 1 : 0 } END { if (w != "") print "GEOM@" id ":" x + 0, y + 0, w + 0, h + 0, v + 0, o + 0 }'; echo "EXT@$1:$(xprop -id "$1" _NET_FRAME_EXTENTS 2>/dev/null | sed -n 's/.* = //p' | tr -d ',')"; }`,
  ];
  if (points) {
    lines.push(
      'stack=$(xprop -root _NET_CLIENT_LIST_STACKING 2>/dev/null); echo "STACK:$stack"',
      'for w in $(printf "%s\\n" "$stack" | grep -o "0x[0-9a-fA-F]*"); do geom "$w"; describe "$w"; done',
      `for w in $(xwininfo -root -children 2>/dev/null | awk '$1 ~ /^0x[0-9a-fA-F]+$/ { print $1 }'); do geom "$w"; done`,
    );
  } else {
    lines.push(
      'f=$(xdotool getwindowfocus 2>/dev/null); [ -n "$f" ] && f=$(printf "0x%x" "$f" 2>/dev/null); echo "FOCUS:$f"; [ -n "$f" ] && describe "$f"',
    );
  }
  if (withSites) {
    // The process listening on the DevTools port is the one browser instance
    // the tab list describes: find its listening socket's inode, then the
    // process holding it.
    const portHex = DESKTOP_CHROMIUM_CDP_PORT.toString(16).toUpperCase().padStart(4, '0');
    lines.push(
      `echo "CDP:$(timeout 8 node - 2>/dev/null <<'AGENT_HUB_CDP_SCRIPT' | tr -d '\\n'\n${CDP_FRAME_TREE_SCRIPT}\nAGENT_HUB_CDP_SCRIPT\n)"`,
      `cdp_inode=$(awk 'FNR > 1 && $4 == "0A" && $2 ~ /:${portHex}$/ { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)`,
      'cdp_fd=$( [ -n "$cdp_inode" ] && find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[$cdp_inode\\]" 2>/dev/null | head -n 1 )',
      'cdp_pid=${cdp_fd#/proc/}; cdp_pid=${cdp_pid%%/*}; echo "CDPPID:$cdp_pid"',
    );
  }
  return lines.join('\n');
}

/**
 * The quoted values of an xprop line, unescaped. xprop backslash-escapes `"`
 * and `\`, and in a non-UTF-8 locale prints other bytes as `\ooo` octal.
 * Unescaped runs are encoded as whole strings (never per UTF-16 unit, which
 * would split surrogate pairs such as emoji) and octal escapes added as raw
 * bytes, then the bytes are read back as UTF-8.
 */
export function xpropQuotedStrings(line: string): string[] {
  return Array.from(line.matchAll(/"((?:[^"\\]|\\.)*)"/gu), (m) => {
    const chunks: Buffer[] = [];
    for (const part of m[1].matchAll(/\\([0-7]{1,3})|\\(.)|([^\\]+)/gsu)) {
      if (part[1] !== undefined) chunks.push(Buffer.from([parseInt(part[1], 8) & 0xff]));
      else if (part[2] !== undefined)
        chunks.push(Buffer.from(part[2] === 'n' ? '\n' : part[2], 'utf8'));
      else chunks.push(Buffer.from(part[3], 'utf8'));
    }
    return Buffer.concat(chunks).toString('utf8');
  });
}

/**
 * One canonical form for any title before comparison, so the X window title
 * and the DevTools title compare as the same text: Unicode NFC.
 */
export function canonicalTitle(title: string): string {
  return title.normalize('NFC');
}

/** `WM_CLASS(STRING) = "chromium", "Chromium"` → `chromium` (the class, not the instance). */
export function parseWmClass(line: string): string | null {
  const quoted = xpropQuotedStrings(line);
  return normalizeDesktopAppName(quoted[quoted.length - 1]);
}

/**
 * DevTools' `/json/list` HTML-escapes tab titles (`A &amp; B`). One decoding
 * pass, so a title that really contains `&amp;` (sent as `&amp;amp;`) reads
 * back exactly.
 */
export function decodeDevtoolsTitle(title: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return title.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Surrogate code points are not characters; leave them encoded.
      return Number.isFinite(code) &&
        code >= 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return named[ent.toLowerCase()] ?? whole;
  });
}

/** What a tab is known to act as. Known hosts are kept even when incomplete. */
export interface TabSites {
  hosts: string[];
  complete: boolean;
}

interface CdpPage {
  id: string;
  /** `page` (a tab) or `iframe` (an out-of-process frame inside one). */
  type: 'page' | 'iframe';
  /** Decoded title, exactly as the window shows it. */
  title: string;
  url: string;
  /** For an iframe: the id of the target it is embedded in. */
  parentId: string | null;
  /**
   * Effective origin of every frame in the target (`''` for one that could
   * not be read), or null when the frame tree could not be read at all.
   */
  frameOrigins: string[] | null;
}

function parseCdpPages(raw: string): CdpPage[] | null {
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: CdpPage[] = [];
    for (const t of parsed as Array<Record<string, unknown>>) {
      if (!t || typeof t !== 'object') continue;
      if (t.type !== 'page' && t.type !== 'iframe') continue;
      if (typeof t.url !== 'string') continue;
      out.push({
        id: typeof t.id === 'string' ? t.id : '',
        type: t.type,
        title: typeof t.title === 'string' ? canonicalTitle(decodeDevtoolsTitle(t.title)) : '',
        url: t.url,
        parentId: typeof t.parentId === 'string' && t.parentId ? t.parentId : null,
        frameOrigins:
          Array.isArray(t.frameOrigins) && t.frameOrigins.every((o) => typeof o === 'string')
            ? (t.frameOrigins as string[])
            : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The sites a tab acts as: the effective origin of every frame in it, plus those of every out-of-process iframe target embedded
 * in it (recursively, by parentId). Origins are each document's own, so an
 * about:blank frame counts as the site it inherited and same-process
 * subframes are included. Every attributable origin is kept even when
 * another frame is not: `complete` is false when any target's frame tree was
 * not reported or any origin is opaque or unattributable, but the known
 * hosts still count, so an opaque sibling can never hide a blocked origin.
 */
export function sitesOfTab(tab: CdpPage, all: CdpPage[]): TabSites {
  const hosts = new Set<string>();
  let complete = true;
  const seen = new Set<string>();
  const visit = (t: CdpPage): void => {
    if (t.id) {
      if (seen.has(t.id)) return;
      seen.add(t.id);
    }
    if (t.frameOrigins === null || t.frameOrigins.length === 0) complete = false;
    for (const origin of t.frameOrigins ?? []) {
      const site = siteOfUrl(origin);
      if (site === null) complete = false;
      else if (site.host) hosts.add(site.host);
    }
    if (t.id) all.filter((c) => c.type === 'iframe' && c.parentId === t.id).forEach(visit);
  };
  visit(tab);
  return { hosts: [...hosts], complete };
}

/** Suffixes Chromium-family browsers append to the window title. */
const BROWSER_TITLE_SUFFIXES = [' - Chromium', ' - Google Chrome'];

/**
 * The tabs a browser window shows, matched by exact title only: the window
 * title, or the window title minus the browser's own suffix, must equal the
 * tab title. Never a prefix match, which could pick a background tab whose
 * title happens to start the visible one's. Every exact match is kept (two
 * tabs can share a title), so the strictest of their sites wins. An empty
 * result means the tab could not be identified.
 */
export function pagesForWindowTitle(windowTitle: string, pages: CdpPage[]): CdpPage[] {
  if (!windowTitle) return [];
  windowTitle = canonicalTitle(windowTitle);
  const candidates = new Set([windowTitle]);
  for (const suffix of BROWSER_TITLE_SUFFIXES) {
    if (windowTitle.endsWith(suffix)) candidates.add(windowTitle.slice(0, -suffix.length));
  }
  return pages.filter((p) => p.type === 'page' && p.title !== '' && candidates.has(p.title));
}

/**
 * Schemes of browser-internal pages that no website can open or script: the
 * page has no site for a policy to cover. `about:` is deliberately absent:
 * about:blank and about:srcdoc documents inherit the origin of whoever
 * created them, so their URL does not say which site they act as.
 */
const NON_SITE_SCHEMES = new Set([
  'chrome:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'file:',
]);

/**
 * The site a document acts as, judged only from what its URL proves about its
 * origin: `{ host }` for http(s), `{ host: null }` for a browser-internal page
 * or a local file, and `null` (unknown) for everything whose origin can be
 * inherited or opaque (about:, data:, javascript:, view-source:, error pages,
 * extensions, unparseable or unrecognised URLs). blob: and filesystem: URLs
 * carry the creating origin and resolve through it.
 */
export function siteOfUrl(url: string): { host: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'blob:' || u.protocol === 'filesystem:') {
    return url.length > u.protocol.length ? siteOfUrl(url.slice(u.protocol.length)) : null;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const host = normalizeBrowserLoginDomain(url);
    return host ? { host } : null;
  }
  return NON_SITE_SCHEMES.has(u.protocol) ? { host: null } : null;
}

/** Window ids in any spelling (0x1A00003, 0x1a00003) compare as numbers. */
function windowIdKey(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,8}$/.test(v)) return null;
  return String(parseInt(v, 16));
}

/** The value of `<tag>@<id>:` for a window; null when absent or conflicting. */
function windowRecord(lines: string[], tag: string, id: string): string | null {
  const values = new Set<string>();
  for (const l of lines) {
    const m = new RegExp(`^${tag}@(0x[0-9a-fA-F]+):`).exec(l);
    if (m && windowIdKey(m[1]) === id) values.add(l.slice(m[0].length));
  }
  return values.size === 1 ? [...values][0] : null;
}

interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  viewable: boolean;
  overrideRedirect: boolean;
  /** Frame extents left, right, top, bottom (title bar and borders). */
  ext: [number, number, number, number];
}

function windowGeometry(lines: string[], id: string): WindowGeometry | null {
  const g = windowRecord(lines, 'GEOM', id);
  const nums = g?.trim().split(/\s+/).map(Number);
  if (!nums || nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) return null;
  const extRaw = windowRecord(lines, 'EXT', id)?.trim() ?? '';
  const ext = extRaw.split(/\s+/).map(Number);
  return {
    x: nums[0],
    y: nums[1],
    w: nums[2],
    h: nums[3],
    viewable: nums[4] === 1,
    overrideRedirect: nums[5] === 1,
    ext:
      ext.length === 4 && ext.every((n) => Number.isFinite(n) && n >= 0)
        ? (ext as [number, number, number, number])
        : [0, 0, 0, 0],
  };
}

function containsPoint(
  g: WindowGeometry,
  p: { x: number; y: number },
  withFrame: boolean,
): boolean {
  const [l, r, t, b] = withFrame ? g.ext : [0, 0, 0, 0];
  return p.x >= g.x - l && p.x < g.x + g.w + r && p.y >= g.y - t && p.y < g.y + g.h + b;
}

/**
 * The client window a point lands on, found passively: the topmost viewable
 * client in the window manager's stacking order whose frame (title bar and
 * borders included) contains the point. Null (an unknown window) when the
 * stacking order is missing, a client in it has no geometry, or any viewable
 * override-redirect window (menu, tooltip, popup) covers the point, since its
 * place in the stack relative to the clients is not known here.
 */
export function hitTestWindow(stdout: string, p: { x: number; y: number }): string | null {
  const lines = stdout.split('\n');
  const stackLines = lines.filter((l) => l.startsWith('STACK:'));
  if (stackLines.length !== 1) return null;
  const stack = Array.from(stackLines[0].matchAll(/0x[0-9a-fA-F]+/g), (m) => windowIdKey(m[0]));
  if (stack.length === 0 || stack.some((id) => id === null)) return null;
  for (const l of lines) {
    const m = /^GEOM@(0x[0-9a-fA-F]+):/.exec(l);
    const id = m && windowIdKey(m[1]);
    const g = id ? windowGeometry(lines, id) : null;
    if (g?.viewable && g.overrideRedirect && containsPoint(g, p, false)) return null;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const g = windowGeometry(lines, stack[i]!);
    if (!g) return null;
    if (g.viewable && containsPoint(g, p, true)) return stack[i];
  }
  return null;
}

/**
 * Turn the probe's window-keyed output into one indexed record per place
 * the op lands (`APP<i>:`, `TITLE<i>:`, `PID<i>:`, `EXE<i>:`): pointer ops
 * by hit-testing each point, keyboard ops by the focused window. A place
 * with no identified window gets empty records, which read as unknown.
 * Output already in indexed form passes through.
 */
export function resolveProbeWindows(
  stdout: string,
  points: Array<{ x: number; y: number }> | null,
): string {
  const lines = stdout.split('\n');
  if (!lines.some((l) => l.startsWith('STACK:') || l.startsWith('FOCUS:'))) return stdout;
  let ids: Array<string | null>;
  if (points) {
    ids = points.map((p) => hitTestWindow(stdout, p));
  } else {
    const focus = lines.filter((l) => l.startsWith('FOCUS:'));
    ids = [focus.length === 1 ? windowIdKey(focus[0].slice(6)) : null];
  }
  const out: string[] = [];
  ids.forEach((id, i) => {
    for (const tag of ['APP', 'TITLE', 'PID', 'EXE']) {
      out.push(`${tag}${i}:${id ? (windowRecord(lines, tag, id) ?? '') : ''}`);
    }
  });
  out.push(...lines.filter((l) => l.startsWith('CDP:') || l.startsWith('CDPPID:')));
  return `${out.join('\n')}\n`;
}

function parsePid(raw: string): number | null {
  const v = raw.trim();
  return /^[1-9][0-9]{0,9}$/.test(v) ? Number(v) : null;
}

function recordLine(lines: string[], tag: string, i: number): string | null {
  const prefix = `${tag}${i}:`;
  const hits = lines.filter((l) => l.startsWith(prefix));
  return hits.length === 1 ? hits[0].slice(prefix.length) : null;
}

/**
 * Targets from probe output. Anything not positively identified reads as
 * unknown: a missing or duplicated record is an unknown window; a window
 * whose process cannot be read, or a browser whose tab cannot be matched
 * exactly or whose URL has no clear site, is an unknown site.
 */
export function parseTargetProbeOutput(
  stdout: string,
  expected: number,
  withSites: boolean,
): DesktopTarget[] {
  const lines = stdout.split('\n');
  const cdpLines = lines.filter((l) => l.startsWith('CDP:'));
  const pages = withSites && cdpLines.length === 1 ? parseCdpPages(cdpLines[0].slice(4)) : null;
  const cdpPidLines = lines.filter((l) => l.startsWith('CDPPID:'));
  const cdpPid = cdpPidLines.length === 1 ? parsePid(cdpPidLines[0].slice(7)) : null;
  const out: DesktopTarget[] = [];
  for (let i = 0; i < expected; i++) {
    const appLine = recordLine(lines, 'APP', i);
    const app = (appLine !== null && parseWmClass(appLine)) || DESKTOP_UNKNOWN_APP;
    const exeLine = recordLine(lines, 'EXE', i);
    const exe = exeLine?.trim() || null;
    const pidLine = recordLine(lines, 'PID', i);
    const pid = pidLine === null ? null : parsePid(pidLine);
    const shell = isTerminal(app, exe);
    if (!withSites) {
      out.push({ app, hosts: [], siteUnknown: false, shell });
      continue;
    }
    const titleLine = recordLine(lines, 'TITLE', i);
    const windowTitle = titleLine === null ? '' : (xpropQuotedStrings(titleLine)[0] ?? '');
    const titleMatches = pages ? pagesForWindowTitle(windowTitle, pages) : [];
    // The tab list describes one browser instance: the process listening on
    // the DevTools port. Its tabs say what this window shows only when this
    // window belongs to that process; another instance can have a tab with
    // the same title on a different site.
    const bound = pid !== null && cdpPid !== null && pid === cdpPid;
    // Whether the window is a browser comes from what it is: its process's
    // executable, its class, or being the DevTools instance. A window whose
    // process cannot be read is not known to be a non-browser, and an
    // unbound window whose title matches a tab may be another instance of
    // the browser, so both are unknown sites.
    const browser =
      bound || DESKTOP_BROWSER_APPS.has(app) || (exe !== null && isBrowserExecutable(exe));
    // Tabs this window may be showing. Bound: the title matches are its tabs.
    // Unbound: a matching tab may be what it shows (another instance), so its
    // sites count as possible ones, never as the full answer.
    const tabs = titleMatches.map((p) => sitesOfTab(p, pages ?? []));
    const hosts = Array.from(new Set(tabs.flatMap((t) => t.hosts)));
    if (!browser) {
      // Not known to be a non-browser (unreadable process), or showing a title
      // that matches a tab: unknown, with any matched tab's sites kept.
      out.push({ app, hosts, siteUnknown: exe === null || titleMatches.length > 0, shell });
      continue;
    }
    const complete = bound && tabs.length > 0 && tabs.every((t) => t.complete);
    out.push({ app, hosts, siteUnknown: !complete, shell });
  }
  return out;
}

export type ComputerGateResult =
  | {
      proceed: true;
      notice?: string;
      /** Keys of the targets the op was checked against; empty when nothing gates the desktop. */
      targets?: string[];
      /**
       * Keys a human explicitly approved in this call. Only these may be
       * passed back as `clearedTargets`; a target that was merely allowed
       * must be checked again, since its policy can change at any time.
       */
      approved?: string[];
    }
  | { proceed: false; markdown: string; hostDetail: string; halt: string };

/** Runs a short command on the desktop the op targets. */
export type DesktopProbe = (command: string) => Promise<DesktopExecResult>;

export interface ComputerGateCallOptions {
  /**
   * Target keys the human explicitly approved earlier in the op this call
   * continues (the rest of a key sequence): the `approved` keys of earlier
   * results, never targets that were only allowed. An op landing only on
   * these targets does not ask again; block policies still apply.
   */
  clearedTargets?: readonly string[];
}

export type ComputerApprovalGate = (
  op: DesktopOp,
  probe: DesktopProbe,
  opts?: ComputerGateCallOptions,
) => Promise<ComputerGateResult>;

const TYPED_TEXT_PREVIEW_CHARS = 120;
const COMMAND_PREVIEW_CHARS = 400;

function describeOp(op: DesktopOp, appLabel: string): string {
  switch (op.op) {
    case 'click':
    case 'double_click':
      return `${op.op === 'click' ? 'Click' : 'Double-click'} (${op.button}) at (${op.x}, ${op.y}) in ${appLabel}`;
    case 'drag':
      return `Drag (${op.x}, ${op.y}) → (${op.toX}, ${op.toY}) in ${appLabel}`;
    case 'scroll':
      return `Scroll ${op.direction} ×${op.amount} at (${op.x}, ${op.y}) in ${appLabel}`;
    case 'type': {
      const chars = Array.from(op.text);
      const text = chars.slice(0, TYPED_TEXT_PREVIEW_CHARS).join('');
      const more = chars.length > TYPED_TEXT_PREVIEW_CHARS ? '…' : '';
      return `Type "${text}${more}" into ${appLabel}`;
    }
    case 'key':
      return `Press ${op.combo} in ${appLabel}`;
    case 'exec': {
      const cmdChars = Array.from(op.command);
      const cmd = cmdChars.slice(0, COMMAND_PREVIEW_CHARS).join('');
      const more = cmdChars.length > COMMAND_PREVIEW_CHARS ? '…' : '';
      return `Run \`${cmd}${more}\`${op.cwd ? ` in ${op.cwd}` : ''} on the desktop`;
    }
    default:
      return op.op;
  }
}

function refusal(
  op: string,
  lines: string[],
  hostDetail: string,
  halt: string,
): ComputerGateResult {
  return {
    proceed: false,
    markdown: [`## Computer: ${op} refused`, '', ...lines].join('\n'),
    hostDetail,
    halt: `computer ${op} ${halt}`,
  };
}

function isDesktopDomain(domain: string): boolean {
  return hostWithinDomain(domain, DESKTOP_APP_DOMAIN_SUFFIX);
}

/** Which kinds of target anything in the profile gates. */
interface GateScope {
  apps: boolean;
  sites: boolean;
}

function profileGateScope(profileId: string): GateScope {
  const scope: GateScope = { apps: false, sites: false };
  const mark = (domain: string) => {
    if (isDesktopDomain(domain)) scope.apps = true;
    else scope.sites = true;
  };
  for (const p of listBrowserDomainPolicies(profileId)) if (p.policy !== 'allow') mark(p.domain);
  const rows = getOrgsDb()
    .prepare(`SELECT domain FROM approval_rules WHERE profile_id = ? AND effect = 'require'`)
    .all(profileId) as Array<{ domain: string }>;
  for (const r of rows) mark(r.domain);
  return scope;
}

interface Source {
  domain: string;
  verdict: BrowserGateDecision;
  /** Overrides the policy-derived reason shown to the human. */
  why?: string;
}

const SHELL_TRUST_REASON =
  'Shell commands can reach any app or site, so they ask while any desktop or site policy is set. Set desktop:shell to Allow (or answer Always allow) to trust them.';

interface Evaluation {
  block: Source | null;
  asks: Source[];
  /** A target the host could not fully identify while something it might be is gated. */
  unidentified: boolean;
}

function evaluateTargets(
  profileId: string,
  targets: DesktopTarget[],
  action: string,
  scope: GateScope,
): Evaluation {
  const sources: Source[] = [];
  const shellDomain = desktopAppDomain(DESKTOP_SHELL_APP);
  for (const t of targets) {
    const domains = new Set([desktopAppDomain(t.app), ...t.hosts]);
    if (t.shell) domains.add(shellDomain);
    for (const domain of domains) {
      const verdict = decideBrowserDomainGate({ profileId, host: domain, action });
      // A shell reaches past every other policy, so while any policy is set
      // it is trusted only by an explicit allow policy or rule, never by
      // the absence of one.
      if (
        domain === shellDomain &&
        verdict.decision === 'allow' &&
        verdict.reason === 'no_policy' &&
        (scope.apps || scope.sites) &&
        findApprovalRule({ profileId, domain, action })?.effect !== 'allow'
      ) {
        sources.push({
          domain,
          verdict: { decision: 'ask', reason: 'ask_policy', policyDomain: null },
          why: SHELL_TRUST_REASON,
        });
        continue;
      }
      sources.push({ domain, verdict });
    }
  }
  const unidentified = targets.some(
    (t) =>
      (t.app === DESKTOP_UNKNOWN_APP && (scope.apps || scope.sites)) ||
      (t.siteUnknown && scope.sites),
  );
  return {
    block: sources.find((s) => s.verdict.decision === 'block') ?? null,
    asks: sources.filter((s) => s.verdict.decision === 'ask'),
    unidentified,
  };
}

function targetLabel(t: DesktopTarget): string {
  const app = formatPolicyDomain(desktopAppDomain(t.app));
  const sites = [...t.hosts, ...(t.siteUnknown ? ['a site the host could not read'] : [])];
  return sites.length ? `${app}, on ${sites.join(' / ')}` : app;
}

function targetsLabel(targets: DesktopTarget[]): string {
  return Array.from(new Set(targets.map(targetLabel))).join(' and ');
}

function askReason(s: Source): string {
  if (s.why) return s.why;
  const v = s.verdict;
  if (v.decision !== 'ask') return '';
  return v.reason === 'require_rule'
    ? `A require-approval rule on ${formatPolicyDomain(v.rule?.domain ?? s.domain)} applies.`
    : `The policy for ${formatPolicyDomain(v.policyDomain ?? s.domain)} is "ask".`;
}

function blockedBy(s: Source): string {
  const v = s.verdict;
  return formatPolicyDomain(v.decision === 'block' ? v.policyDomain : s.domain);
}

export interface ComputerGateOptions {
  /** Deny-list patterns; null / undefined uses the defaults. */
  execApprovalPatterns?: readonly string[] | null;
}

/**
 * Build the gate for one chat turn. Returns undefined when the session has
 * no owner or project: there is no desktop to act on, so nothing to gate.
 */
export function createComputerApprovalGate(
  ctx: ApprovalContext,
  deps: ApprovalDeps = {},
  opts: ComputerGateOptions = {},
): ComputerApprovalGate | undefined {
  if (!ctx.ownerUserId || !ctx.projectId) return undefined;
  const key = { userId: ctx.ownerUserId, agentId: ctx.agentId, projectId: ctx.projectId };
  const patterns = compileExecApprovalPatterns(opts.execApprovalPatterns);

  const policyUnavailable = (op: string, err: unknown): ComputerGateResult => {
    console.warn(`[computer-policy] policy lookup failed, refusing ${op}: ${String(err)}`);
    return refusal(
      op,
      [
        `\`${op}\` was not performed: the human's desktop policy could not be read, so the op is treated as blocked. Do not retry it or do it another way. Tell the human in chat what you could not do.`,
      ],
      'policy_unavailable',
      'was refused: the desktop policy could not be read',
    );
  };

  const resolveTargets = async (
    op: DesktopOp,
    probe: DesktopProbe,
    scope: GateScope,
  ): Promise<DesktopTarget[]> => {
    if (op.op === 'exec') {
      return [{ app: DESKTOP_SHELL_APP, hosts: [], siteUnknown: false, shell: true }];
    }
    const r = await probe(buildTargetProbeCommand(op, scope.sites)!);
    return parseTargetProbeOutput(
      resolveProbeWindows(r.stdout, opPoints(op)),
      targetCount(op),
      scope.sites,
    );
  };

  /**
   * The one place a decision is made: read the profile and policy now,
   * resolve what the op lands on now, and evaluate. Runs before asking and
   * again after every approval.
   */
  const assess = async (
    op: DesktopOp,
    probe: DesktopProbe,
  ): Promise<{
    profileId: string | null;
    targets: DesktopTarget[];
    evaluation: Evaluation | null;
  }> => {
    const profileId = getBrowserProfile(key)?.id ?? null;
    const scope = profileId ? profileGateScope(profileId) : { apps: false, sites: false };
    if (!profileId || (!scope.apps && !scope.sites)) {
      return { profileId, targets: [], evaluation: null };
    }
    const targets = await resolveTargets(op, probe, scope);
    return {
      profileId,
      targets,
      evaluation: evaluateTargets(profileId, targets, op.op, scope),
    };
  };

  const blockRefusal = (action: string, block: Source, targets: DesktopTarget[], after: boolean) =>
    refusal(
      action,
      [
        after
          ? `\`${action}\` was approved, but it now lands on ${targetsLabel(targets)}, which ${blockedBy(block)} blocks in the human's policy, so it was not performed. Tell the human in chat what you could not do.`
          : `\`${action}\` lands on ${targetsLabel(targets)}, which the human's policy blocks (rule on ${blockedBy(block)}). It was not performed. Do not act on it or reach it another way. Tell the human in chat what you could not do.`,
      ],
      after ? 'blocked_during_approval' : 'blocked',
      after ? 'was refused: the target was blocked during approval' : 'was refused by the policy',
    );

  return async (op, probe, callOpts = {}) => {
    if (!isGatedComputerOp(op.op)) return { proceed: true };
    const action = op.op;
    const denyPattern = op.op === 'exec' ? matchExecApprovalPattern(op.command, patterns) : null;

    let before: Awaited<ReturnType<typeof assess>>;
    try {
      before = await assess(op, probe);
    } catch (err) {
      return policyUnavailable(action, err);
    }
    const { profileId, targets, evaluation } = before;
    const keys = targets.map(desktopTargetKey);
    if (evaluation?.block) return blockRefusal(action, evaluation.block, targets, false);

    const cleared = callOpts.clearedTargets ?? [];
    if (
      evaluation &&
      !evaluation.unidentified &&
      !denyPattern &&
      keys.length > 0 &&
      keys.every((k) => cleared.includes(k))
    ) {
      return { proceed: true, targets: keys };
    }
    const asks = evaluation?.asks ?? [];
    const unidentified = evaluation?.unidentified ?? false;
    if (asks.length === 0 && !unidentified && !denyPattern) {
      return { proceed: true, targets: keys };
    }

    const label =
      targets.length > 0
        ? targetsLabel(targets)
        : formatPolicyDomain(desktopAppDomain(DESKTOP_SHELL_APP));
    const why: string[] = [];
    if (denyPattern) {
      why.push(
        `The command matches the desktop exec deny list (\`${denyPattern}\`), so it always needs approval.`,
      );
    }
    for (const reason of new Set(asks.map(askReason))) why.push(reason);
    if (unidentified) {
      why.push(
        'The host could not tell exactly which app or site this lands on, and some apps or sites need approval.',
      );
    }

    if (deps.isCancelled?.()) {
      return refusal(
        action,
        [`The user stopped this turn before \`${action}\` on ${label} could be approved.`],
        'cancelled_before_request',
        'was stopped before approval',
      );
    }

    // An Always allow can only be saved when exactly one domain is asking and
    // nothing about the target is unknown; the deny list is never remembered.
    const askingDomains = new Set(asks.map((s) => s.domain));
    const rememberDomain =
      !denyPattern && !unidentified && askingDomains.size === 1 ? [...askingDomains][0] : null;
    const approval = await requestHostApproval(
      {
        profileId,
        action,
        target: op.op === 'exec' ? `desktop: ${op.command}` : `desktop: ${label}`,
        domain: rememberDomain,
        details: `${describeOp(op, label)}. ${why.join(' ')}`,
      },
      ctx,
      deps,
    );

    if (approval.status === 'allowed') {
      let after: Awaited<ReturnType<typeof assess>>;
      try {
        after = await assess(op, probe);
      } catch (err) {
        return policyUnavailable(action, err);
      }
      if (after.evaluation?.block) {
        return blockRefusal(action, after.evaluation.block, after.targets, true);
      }
      const afterKeys = after.targets.map(desktopTargetKey);
      // Targets read before the wait must still be what the op lands on.
      // (Before-keys are empty only for a deny-listed exec that nothing
      // gated: the approval named that exact command.)
      if (keys.length > 0 && afterKeys.join('\n') !== keys.join('\n')) {
        return refusal(
          action,
          [
            `The human approved \`${action}\` on ${label}, but it now lands on ${after.targets.length ? targetsLabel(after.targets) : 'something the policy no longer covers'}. Nothing was done. Take a screenshot; acting on it needs a fresh approval.`,
          ],
          'screen_changed_during_approval',
          'was not performed: the screen changed during approval',
        );
      }
      return {
        proceed: true,
        targets: afterKeys.length > 0 ? afterKeys : keys,
        approved: afterKeys.length > 0 ? afterKeys : keys,
        notice: `Host approval: the human allowed \`${action}\` on ${label} (${approval.resolution}).`,
      };
    }
    const outcome =
      approval.resolution === 'deny'
        ? 'the human denied it'
        : approval.resolution === 'timeout'
          ? 'nobody answered within 24 hours, so it was denied'
          : 'the request ended before anyone answered';
    return refusal(
      action,
      [
        `\`${action}\` on ${label} needs the human's approval (${why.join(' ')}) and ${outcome}. It was not performed. Do not retry it or find another way to do it. Tell the human in chat what you did not do.`,
      ],
      `approval_${approval.resolution ?? 'unknown'}`,
      `on ${label} was not approved`,
    );
  };
}
