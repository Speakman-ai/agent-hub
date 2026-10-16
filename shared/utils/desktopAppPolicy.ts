/**
 * Desktop apps share the browser profile's policy and approval-rule tables,
 * keyed by a pseudo-domain under the reserved `.invalid` TLD (RFC 6761), so
 * no real site can ever collide with one:
 *
 *   chromium.desktop.invalid   the Chromium window on the agent's desktop
 *   shell.desktop.invalid      the computer tool's `exec` op
 *   desktop.invalid            every desktop app (a policy covers subdomains)
 *
 * Shared by the server gate and the web / mobile settings panes.
 */

export const DESKTOP_APP_DOMAIN_SUFFIX = 'desktop.invalid';
/** App key for the computer tool's `exec` op. */
export const DESKTOP_SHELL_APP = 'shell';
/** App key when the host cannot tell which window an op lands on. */
export const DESKTOP_UNKNOWN_APP = 'unknown';
/** What users type in the policy form: `desktop:chromium`, or `desktop` for all apps. */
export const DESKTOP_APP_INPUT_PREFIX = 'desktop:';

/** `Google-chrome` → `google-chrome`. Null when nothing usable is left. */
export function normalizeDesktopAppName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return v || null;
}

export function desktopAppDomain(app: string): string {
  return `${normalizeDesktopAppName(app) ?? DESKTOP_UNKNOWN_APP}.${DESKTOP_APP_DOMAIN_SUFFIX}`;
}

/**
 * The app a pseudo-domain names: the app key, `''` for the all-apps root,
 * or null when `domain` is a real site.
 */
export function desktopAppFromDomain(domain: string): string | null {
  const d = domain.trim().toLowerCase();
  if (d === DESKTOP_APP_DOMAIN_SUFFIX) return '';
  const suffix = `.${DESKTOP_APP_DOMAIN_SUFFIX}`;
  return d.endsWith(suffix) ? d.slice(0, -suffix.length) : null;
}

/** `desktop:chromium` → `chromium.desktop.invalid`; null for anything else. */
export function parseDesktopAppInput(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === 'desktop') return DESKTOP_APP_DOMAIN_SUFFIX;
  if (!v.startsWith(DESKTOP_APP_INPUT_PREFIX)) return null;
  const app = normalizeDesktopAppName(v.slice(DESKTOP_APP_INPUT_PREFIX.length));
  return app ? desktopAppDomain(app) : null;
}

/** Human label for a policy / rule / approval domain. Real sites pass through. */
export function formatPolicyDomain(domain: string): string {
  const app = desktopAppFromDomain(domain);
  if (app === null) return domain;
  if (app === '') return 'all desktop apps';
  if (app === DESKTOP_SHELL_APP) return 'desktop shell commands';
  if (app === DESKTOP_UNKNOWN_APP) return 'unidentified desktop windows';
  return `${app} (desktop app)`;
}
