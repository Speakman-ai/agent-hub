/**
 * QA environments: the servers a project's QA plans test against and the test
 * accounts for each, so every run and authoring session knows where it is and
 * how to log in without the user restating it per plan.
 *
 * Passwords are encrypted at rest and never returned by the API (MASK when
 * set). A QA session never sees plaintext either: its seed lists each account
 * with a `{{qa-password:<accountId>}}` placeholder, and the chat loop swaps the
 * placeholder for the decrypted value inside a `browser` / `preview` `type`
 * action just before the host fills the field (`resolveQaPasswordPlaceholders`).
 * The transcript only ever holds the placeholder.
 */
import { randomBytes, randomUUID } from 'crypto';
import { getDb } from './db.js';
import { decryptSecret, encryptSecret, MASK } from './secret-crypto.js';

export const QA_ENV_LIMITS = {
  name: 100,
  baseUrl: 2_000,
  notes: 10_000,
  accounts: 50,
  label: 100,
  username: 300,
  password: 1_000,
  accountNotes: 2_000,
  environments: 50,
} as const;

interface StoredAccount {
  id: string;
  label: string;
  username: string;
  password_enc: string;
  notes: string;
}

interface QaEnvironmentRow {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  notes: string;
  accounts: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface QaEnvironmentAccountView {
  id: string;
  label: string;
  username: string;
  /** MASK when a password is stored, '' otherwise. Never the plaintext. */
  password: string;
  hasPassword: boolean;
  notes: string;
}

export interface QaEnvironmentView {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  notes: string;
  accounts: QaEnvironmentAccountView[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface QaEnvironmentAccountInput {
  /** Existing account id; omitted or unknown ids create a new account. */
  id?: string;
  label: string;
  username?: string;
  /** Omitted or MASK keeps the stored password; '' clears it. */
  password?: string;
  notes?: string;
}

export interface QaEnvironmentInput {
  name: string;
  baseUrl?: string;
  notes?: string;
  accounts?: QaEnvironmentAccountInput[];
}

export class QaEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

function parseAccounts(raw: string): StoredAccount[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredAccount[]) : [];
  } catch {
    return [];
  }
}

function toView(row: QaEnvironmentRow): QaEnvironmentView {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    baseUrl: row.base_url,
    notes: row.notes,
    accounts: parseAccounts(row.accounts).map((a) => ({
      id: a.id,
      label: a.label,
      username: a.username,
      password: a.password_enc ? MASK : '',
      hasPassword: !!a.password_enc,
      notes: a.notes,
    })),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rows(projectId: string): QaEnvironmentRow[] {
  return getDb()
    .prepare('SELECT * FROM qa_environments WHERE project_id = ? ORDER BY position ASC, id ASC')
    .all(projectId) as QaEnvironmentRow[];
}

function row(projectId: string, id: string): QaEnvironmentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM qa_environments WHERE project_id = ? AND id = ?')
    .get(projectId, id) as QaEnvironmentRow | undefined;
}

export function listQaEnvironments(projectId: string): QaEnvironmentView[] {
  return rows(projectId).map(toView);
}

export function getQaEnvironment(projectId: string, id: string): QaEnvironmentView | null {
  const r = row(projectId, id);
  return r ? toView(r) : null;
}

function cleanText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new QaEnvironmentError(`${field} must be a string`);
  const v = value.trim();
  if (v.length > max) throw new QaEnvironmentError(`${field} must be at most ${max} characters`);
  return v;
}

function cleanBaseUrl(value: unknown): string {
  const v = cleanText(value, 'baseUrl', QA_ENV_LIMITS.baseUrl);
  if (!v) return '';
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new QaEnvironmentError('baseUrl must be a full http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new QaEnvironmentError('baseUrl must be a full http(s) URL');
  }
  return v;
}

function newAccountId(): string {
  return `acc_${randomBytes(6).toString('hex')}`;
}

function mergeAccounts(
  input: QaEnvironmentAccountInput[] | undefined,
  existing: StoredAccount[],
): StoredAccount[] {
  if (input === undefined) return existing;
  if (!Array.isArray(input)) throw new QaEnvironmentError('accounts must be an array');
  if (input.length > QA_ENV_LIMITS.accounts) {
    throw new QaEnvironmentError(`At most ${QA_ENV_LIMITS.accounts} accounts per environment`);
  }
  const byId = new Map(existing.map((a) => [a.id, a]));
  const seen = new Set<string>();
  return input.map((a, i) => {
    const label = cleanText(a?.label, `accounts[${i}].label`, QA_ENV_LIMITS.label);
    if (!label) throw new QaEnvironmentError(`accounts[${i}].label is required`);
    // Only ids already in this environment are kept, so a caller cannot
    // adopt another environment's account (and its password) by id.
    const prior = typeof a.id === 'string' && !seen.has(a.id) ? byId.get(a.id) : undefined;
    const id = prior ? prior.id : newAccountId();
    seen.add(id);
    let password_enc = prior?.password_enc ?? '';
    if (a.password !== undefined && a.password !== MASK) {
      if (typeof a.password !== 'string') {
        throw new QaEnvironmentError(`accounts[${i}].password must be a string`);
      }
      if (a.password.length > QA_ENV_LIMITS.password) {
        throw new QaEnvironmentError(
          `accounts[${i}].password must be at most ${QA_ENV_LIMITS.password} characters`,
        );
      }
      password_enc = a.password ? encryptSecret(a.password) : '';
    }
    return {
      id,
      label,
      username: cleanText(a.username, `accounts[${i}].username`, QA_ENV_LIMITS.username),
      password_enc,
      notes: cleanText(a.notes, `accounts[${i}].notes`, QA_ENV_LIMITS.accountNotes),
    };
  });
}

function cleanName(value: unknown): string {
  const name = cleanText(value, 'name', QA_ENV_LIMITS.name);
  if (!name) throw new QaEnvironmentError('name is required');
  return name;
}

function assertUniqueName(projectId: string, name: string, exceptId: string | null): void {
  const clash = rows(projectId).find(
    (r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new QaEnvironmentError(`An environment named "${name}" already exists`, 409);
}

export function createQaEnvironment(
  projectId: string,
  input: QaEnvironmentInput,
): QaEnvironmentView {
  const name = cleanName(input.name);
  const existing = rows(projectId);
  if (existing.length >= QA_ENV_LIMITS.environments) {
    throw new QaEnvironmentError(`At most ${QA_ENV_LIMITS.environments} environments per project`);
  }
  assertUniqueName(projectId, name, null);
  const id = randomUUID();
  const position = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
  getDb()
    .prepare(
      `INSERT INTO qa_environments (id, project_id, name, base_url, notes, accounts, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      name,
      cleanBaseUrl(input.baseUrl),
      cleanText(input.notes, 'notes', QA_ENV_LIMITS.notes),
      JSON.stringify(mergeAccounts(input.accounts ?? [], [])),
      position,
    );
  return getQaEnvironment(projectId, id)!;
}

export function updateQaEnvironment(
  projectId: string,
  id: string,
  input: Partial<QaEnvironmentInput>,
): QaEnvironmentView {
  const current = row(projectId, id);
  if (!current) throw new QaEnvironmentError('Environment not found', 404);
  const name = input.name === undefined ? current.name : cleanName(input.name);
  if (name !== current.name) assertUniqueName(projectId, name, id);
  getDb()
    .prepare(
      `UPDATE qa_environments SET name = ?, base_url = ?, notes = ?, accounts = ?,
         updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    )
    .run(
      name,
      input.baseUrl === undefined ? current.base_url : cleanBaseUrl(input.baseUrl),
      input.notes === undefined
        ? current.notes
        : cleanText(input.notes, 'notes', QA_ENV_LIMITS.notes),
      JSON.stringify(mergeAccounts(input.accounts, parseAccounts(current.accounts))),
      id,
      projectId,
    );
  return getQaEnvironment(projectId, id)!;
}

export function deleteQaEnvironment(projectId: string, id: string): boolean {
  const r = getDb()
    .prepare('DELETE FROM qa_environments WHERE project_id = ? AND id = ?')
    .run(projectId, id);
  return r.changes > 0;
}

// --- Password placeholders ----------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*qa-password:([A-Za-z0-9_-]{1,64})\s*\}\}/g;

export function qaPasswordPlaceholder(accountId: string): string {
  return `{{qa-password:${accountId}}}`;
}

export function hasQaPasswordPlaceholder(text: string | undefined): boolean {
  if (!text) return false;
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(text);
}

export type QaPlaceholderResolution =
  | { ok: true; text: string; secrets: string[] }
  | { ok: false; error: string };

/**
 * Replace every `{{qa-password:<accountId>}}` in `text` with the stored
 * password of that account in `projectId`. Unknown accounts and accounts with
 * no password are refused rather than typed literally.
 */
export function resolveQaPasswordPlaceholders(
  projectId: string,
  text: string,
): QaPlaceholderResolution {
  if (!hasQaPasswordPlaceholder(text)) return { ok: true, text, secrets: [] };
  const accounts = new Map<string, StoredAccount>();
  for (const r of rows(projectId)) {
    for (const a of parseAccounts(r.accounts)) accounts.set(a.id, a);
  }
  const secrets: string[] = [];
  let error: string | null = null;
  const out = text.replace(PLACEHOLDER_RE, (whole, id: string) => {
    if (error) return whole;
    const account = accounts.get(id);
    if (!account) {
      error = `No QA test account \`${id}\` in this project. Use an account id listed in the run's environments.`;
      return whole;
    }
    if (!account.password_enc) {
      error = `QA test account \`${id}\` (${account.label}) has no password saved. Mark the case blocked and say so.`;
      return whole;
    }
    let plain: string;
    try {
      plain = decryptSecret(account.password_enc);
    } catch {
      error = `The password for QA test account \`${id}\` could not be decrypted. Ask a human to re-save it in QA settings.`;
      return whole;
    }
    secrets.push(plain);
    return plain;
  });
  if (error) return { ok: false, error };
  return { ok: true, text: out, secrets };
}

/**
 * Replace every occurrence of a substituted secret with `***`. Short
 * passwords are redacted too, even though that can mangle unrelated text in
 * the observation: a garbled observation is better than a leaked password.
 */
export function redactQaSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

// --- Seed block -----------------------------------------------------------

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Markdown block listing a project's QA environments for a seed message.
 * Pure. Holds usernames and password placeholders, never plaintext passwords.
 * The environment whose base URL shares an origin with `targetUrl` is marked.
 */
export function buildQaEnvironmentsBlock(
  environments: readonly QaEnvironmentView[],
  targetUrl?: string | null,
): string {
  if (environments.length === 0) return '';
  const targetOrigin = targetUrl ? originOf(targetUrl) : null;
  const lines = [
    '### Environments',
    '',
    'Configured in QA settings for this project. Use these servers and test accounts instead of asking for them.',
  ];
  for (const env of environments) {
    const matches = !!targetOrigin && !!env.baseUrl && originOf(env.baseUrl) === targetOrigin;
    lines.push('', `#### ${env.name}${matches ? ' (this plan targets it)' : ''}`, '');
    if (env.baseUrl) lines.push(`- **Base URL:** ${env.baseUrl}`);
    if (env.notes) lines.push('- **Notes:**', '', env.notes.replace(/^/gm, '  '), '');
    if (env.accounts.length === 0) {
      lines.push('- **Test accounts:** none');
      continue;
    }
    lines.push('- **Test accounts:**');
    for (const a of env.accounts) {
      const parts = [`**${a.label}**`];
      parts.push(a.username ? `username \`${a.username}\`` : 'no username');
      parts.push(
        a.hasPassword ? `password \`${qaPasswordPlaceholder(a.id)}\`` : 'no password saved',
      );
      lines.push(`  - ${parts.join(', ')}${a.notes ? `. ${a.notes}` : ''}`);
    }
  }
  lines.push(
    '',
    'To enter a password, put its placeholder verbatim in the `text` of a `browser` or `preview` `type` action, e.g. `{"tool":"browser","op":"type","target":"#password","text":"{{qa-password:<accountId>}}"}`. The host types the real value; you never see it, so do not ask for it, echo it, or put the placeholder anywhere else.',
  );
  return lines.join('\n');
}

/**
 * Resolve password placeholders in the `text` of a ReAct `type` action.
 * Only QA sessions of a project may use them; anything else that carries a
 * placeholder is refused so it is never typed literally into a page.
 */
export function substituteQaTypeText(args: {
  sessionMode: string | null | undefined;
  projectId: string | null | undefined;
  op: string | undefined;
  text: string | undefined;
}): QaPlaceholderResolution {
  const text = args.text ?? '';
  if (args.op !== 'type' || !hasQaPasswordPlaceholder(text)) {
    return { ok: true, text, secrets: [] };
  }
  if (args.sessionMode !== 'qa' || !args.projectId) {
    return {
      ok: false,
      error: 'QA password placeholders only work in QA sessions of the project that owns them.',
    };
  }
  return resolveQaPasswordPlaceholders(args.projectId, text);
}

/** Every saved password of a project's QA test accounts, decrypted. */
export function loadQaProjectPasswords(projectId: string): string[] {
  const out: string[] = [];
  for (const r of rows(projectId)) {
    for (const a of parseAccounts(r.accounts)) {
      if (!a.password_enc) continue;
      try {
        const plain = decryptSecret(a.password_enc);
        if (plain) out.push(plain);
      } catch {
        /* undecryptable: nothing could have been typed from it */
      }
    }
  }
  return out;
}

function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactQaSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secrets);
    }
    return out as T;
  }
  return value;
}

export type QaStepGuard =
  | { ok: false; error: string }
  | {
      ok: true;
      /** The `text` operand to run the step with (placeholders resolved). */
      text: string | undefined;
      /** Scrub every QA password out of a step result before anyone sees it. */
      redact: <R>(result: R) => R;
    };

/**
 * One guard per `browser` / `preview` ReAct step. In a QA session it resolves
 * password placeholders in a `type` action and, for every step (not only the
 * one that typed), redacts all of the project's saved test passwords from the
 * result, so a page that later echoes a password (a "show password" toggle, a
 * validation message) cannot leak it through `read_page`, `extract`, or a
 * screenshot's page text.
 */
export function qaStepGuard(args: {
  sessionMode: string | null | undefined;
  projectId: string | null | undefined;
  op: string | undefined;
  text: string | undefined;
}): QaStepGuard {
  const sub = substituteQaTypeText(args);
  if (!sub.ok) return sub;
  const text = sub.secrets.length > 0 ? sub.text : args.text;
  if (args.sessionMode !== 'qa' || !args.projectId) {
    return { ok: true, text, redact: (r) => r };
  }
  const secrets = [...new Set([...sub.secrets, ...loadQaProjectPasswords(args.projectId)])];
  if (secrets.length === 0) return { ok: true, text, redact: (r) => r };
  return { ok: true, text, redact: (r) => redactDeep(r, secrets) };
}
