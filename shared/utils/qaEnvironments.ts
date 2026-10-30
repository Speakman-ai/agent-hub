/**
 * QA environments (servers under test + test accounts) on the wire, and the
 * editor draft both the web and mobile QA settings screens use.
 */

export interface QaEnvironmentAccountWire {
  id: string;
  label: string;
  username: string;
  /** The mask when a password is saved, else ''. */
  password: string;
  hasPassword: boolean;
  notes: string;
}

export interface QaEnvironmentWire {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  notes: string;
  accounts: QaEnvironmentAccountWire[];
  /** Where a session's "Run QA Tests" runs. At most one per project. */
  isDefault?: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface QaEnvironmentInput {
  name: string;
  baseUrl: string;
  notes: string;
  accounts: Array<{
    id?: string;
    label: string;
    username: string;
    password?: string;
    notes: string;
  }>;
}

/** Project-level QA options. */
export interface QaProjectSettingsWire {
  projectId: string;
  /** Minutes a session-requested QA run waits after the session merged. */
  autoQaDelayMinutes: number;
}

export const QA_AUTO_DELAY_MAX_MINUTES = 240;

/** Parse the delay field; null when it is not a whole number in range. */
export function parseQaAutoDelay(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= QA_AUTO_DELAY_MAX_MINUTES ? n : null;
}

/** What the server returns in place of a saved password. */
export const QA_PASSWORD_MASK = '••••••••';

export interface QaAccountDraft {
  /** Local React key; stable across edits. */
  key: string;
  /** Server id once saved. */
  id?: string;
  label: string;
  username: string;
  /** The mask while the saved password is untouched, else what the user typed. */
  password: string;
  notes: string;
}

export interface QaEnvironmentDraft {
  id?: string;
  name: string;
  baseUrl: string;
  notes: string;
  accounts: QaAccountDraft[];
}

let seq = 0;
const nextKey = () => `acct-${++seq}`;

export function emptyQaAccount(): QaAccountDraft {
  return { key: nextKey(), label: '', username: '', password: '', notes: '' };
}

export function emptyQaEnvironment(): QaEnvironmentDraft {
  return { name: '', baseUrl: '', notes: '', accounts: [emptyQaAccount()] };
}

export function draftFromQaEnvironment(env: QaEnvironmentWire): QaEnvironmentDraft {
  return {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    notes: env.notes,
    accounts: env.accounts.map((a) => ({
      key: nextKey(),
      id: a.id,
      label: a.label,
      username: a.username,
      password: a.hasPassword ? QA_PASSWORD_MASK : '',
      notes: a.notes,
    })),
  };
}

/** Rows the user left completely blank are dropped rather than rejected. */
function isBlank(a: QaAccountDraft): boolean {
  return !a.id && !a.label.trim() && !a.username.trim() && !a.password && !a.notes.trim();
}

/** First problem with the draft, or null when it can be saved. */
export function validateQaEnvironmentDraft(d: QaEnvironmentDraft): string | null {
  if (!d.name.trim()) return 'Name is required.';
  const url = d.baseUrl.trim();
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    } catch {
      return 'Base URL must be a full http(s) URL.';
    }
  }
  const missing = d.accounts.findIndex((a) => !isBlank(a) && !a.label.trim());
  if (missing >= 0) return `Account ${missing + 1} needs a label (e.g. Admin).`;
  return null;
}

/**
 * Request body for a draft. An untouched saved password is omitted so the
 * server keeps it; a cleared one is sent as '' so the server removes it.
 */
export function qaEnvironmentDraftToInput(d: QaEnvironmentDraft): QaEnvironmentInput {
  return {
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    notes: d.notes.trim(),
    accounts: d.accounts
      .filter((a) => !isBlank(a))
      .map((a) => ({
        ...(a.id ? { id: a.id } : {}),
        label: a.label.trim(),
        username: a.username.trim(),
        ...(a.password === QA_PASSWORD_MASK ? {} : { password: a.password }),
        notes: a.notes.trim(),
      })),
  };
}

/** Environments a new plan can target: those with a base URL. */
export function selectableQaEnvironments(envs: readonly QaEnvironmentWire[]): QaEnvironmentWire[] {
  return envs.filter((e) => e.baseUrl.trim());
}

/**
 * The environment a target URL points at, or null for a custom URL. Exact
 * base-URL matches win; otherwise the first environment on the same origin.
 */
export function matchQaEnvironment(
  envs: readonly QaEnvironmentWire[],
  targetUrl: string,
): QaEnvironmentWire | null {
  const url = targetUrl.trim();
  if (!url) return null;
  const exact = envs.find((e) => e.baseUrl.trim() && e.baseUrl.trim() === url);
  if (exact) return exact;
  const origin = originOf(url);
  if (!origin) return null;
  return envs.find((e) => e.baseUrl.trim() && originOf(e.baseUrl) === origin) ?? null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}
