import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from './db.js';
import {
  buildQaEnvironmentsBlock,
  createQaEnvironment,
  listQaEnvironments,
  QaEnvironmentError,
  qaPasswordPlaceholder,
  qaStepGuard,
  redactQaSecrets,
  resolveQaPasswordPlaceholders,
  substituteQaTypeText,
  updateQaEnvironment,
} from './qa-environments.js';
import { buildQaRunSeed } from './qa-run-kickoff.js';
import { buildQaAuthoringSeed } from './qa-authoring.js';
import { __setSecretCryptoKeyFilePathForTests, MASK } from './secret-crypto.js';

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-qa-env-'));
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'key'));
  initDb(dir);
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_environments');
});

function staging() {
  return createQaEnvironment('proj', {
    name: 'Staging',
    baseUrl: 'https://staging.example.com',
    notes: 'Seeded nightly. Feature flag beta_checkout is on.',
    accounts: [
      { label: 'Admin', username: 'admin@example.com', password: 'hunter2-admin' },
      { label: 'Viewer', username: 'viewer@example.com' },
    ],
  });
}

describe('QA environment store', () => {
  it('encrypts passwords and only ever returns the mask', () => {
    const env = staging();
    expect(env.accounts[0]).toMatchObject({ password: MASK, hasPassword: true });
    expect(env.accounts[1]).toMatchObject({ password: '', hasPassword: false });
    const raw = getDb().prepare('SELECT accounts FROM qa_environments').get() as {
      accounts: string;
    };
    expect(raw.accounts).not.toContain('hunter2-admin');
    expect(JSON.stringify(listQaEnvironments('proj'))).not.toContain('hunter2-admin');
  });

  it('keeps a password sent back as the mask, replaces or clears it otherwise', () => {
    const env = staging();
    const [admin, viewer] = env.accounts;
    updateQaEnvironment('proj', env.id, {
      accounts: [
        { id: admin.id, label: 'Admin', username: 'admin@example.com', password: MASK },
        { id: viewer.id, label: 'Viewer', password: 'viewer-pw' },
      ],
    });
    let r = resolveQaPasswordPlaceholders('proj', qaPasswordPlaceholder(admin.id));
    expect(r).toEqual({ ok: true, text: 'hunter2-admin', secrets: ['hunter2-admin'] });
    r = resolveQaPasswordPlaceholders('proj', qaPasswordPlaceholder(viewer.id));
    expect(r.ok && r.text).toBe('viewer-pw');

    updateQaEnvironment('proj', env.id, {
      accounts: [{ id: admin.id, label: 'Admin', password: '' }],
    });
    expect(resolveQaPasswordPlaceholders('proj', qaPasswordPlaceholder(admin.id)).ok).toBe(false);
  });

  it('does not let another environment adopt an account id', () => {
    const env = staging();
    const other = createQaEnvironment('proj', {
      name: 'Prod',
      accounts: [{ id: env.accounts[0].id, label: 'Stolen' }],
    });
    expect(other.accounts[0].id).not.toBe(env.accounts[0].id);
    expect(other.accounts[0].hasPassword).toBe(false);
  });

  it('rejects bad base URLs and duplicate names', () => {
    expect(() => createQaEnvironment('proj', { name: 'X', baseUrl: 'ftp://x' })).toThrow(
      QaEnvironmentError,
    );
    staging();
    expect(() => createQaEnvironment('proj', { name: 'staging' })).toThrow(/already exists/);
  });

  it('scopes placeholders to the project', () => {
    const env = staging();
    expect(
      resolveQaPasswordPlaceholders('other', qaPasswordPlaceholder(env.accounts[0].id)),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('substituteQaTypeText', () => {
  it('substitutes only in QA sessions on type actions', () => {
    const env = staging();
    const text = qaPasswordPlaceholder(env.accounts[0].id);
    expect(
      substituteQaTypeText({ sessionMode: 'qa', projectId: 'proj', op: 'type', text }),
    ).toMatchObject({ ok: true, text: 'hunter2-admin' });
    expect(
      substituteQaTypeText({ sessionMode: null, projectId: 'proj', op: 'type', text }).ok,
    ).toBe(false);
    expect(
      substituteQaTypeText({ sessionMode: 'qa', projectId: 'proj', op: 'navigate', text }),
    ).toEqual({ ok: true, text, secrets: [] });
    expect(
      substituteQaTypeText({ sessionMode: null, projectId: 'proj', op: 'type', text: 'plain' }),
    ).toEqual({ ok: true, text: 'plain', secrets: [] });
  });

  it('redacts substituted secrets from observations', () => {
    expect(redactQaSecrets('typed hunter2-admin ok', ['hunter2-admin'])).toBe('typed *** ok');
    expect(redactQaSecrets('pin is 7a9 here', ['7a9'])).toBe('pin is *** here');
    expect(redactQaSecrets('x', ['x'])).toBe('***');
    expect(redactQaSecrets('unchanged', [''])).toBe('unchanged');
  });
});

describe('seed blocks', () => {
  it('lists environments with placeholders, never plaintext, and marks the target', () => {
    const env = staging();
    const block = buildQaEnvironmentsBlock(
      listQaEnvironments('proj'),
      'https://staging.example.com/cart',
    );
    expect(block).toContain('#### Staging (this plan targets it)');
    expect(block).toContain('Seeded nightly');
    expect(block).toContain('`admin@example.com`');
    expect(block).toContain(qaPasswordPlaceholder(env.accounts[0].id));
    expect(block).toContain('**Viewer**, username `viewer@example.com`, no password saved');
    expect(block).not.toContain('hunter2-admin');
    expect(buildQaEnvironmentsBlock([], null)).toBe('');
  });

  it('run and authoring seeds carry the environments', () => {
    staging();
    const environments = listQaEnvironments('proj');
    const plan = {
      id: 'p1',
      title: 'Checkout',
      goal: '',
      target_url: 'https://staging.example.com',
    };
    const run = buildQaRunSeed({
      project: { id: 'proj', name: 'Proj' },
      plan,
      run: { id: 'r1', iteration: 1, scope: 'full' },
      cases: [{ id: 'c1', title: 'Log in', steps: '1. Log in as Admin', expected: 'Dashboard' }],
      routing: { tool: 'browser', reason: 'the target is a public URL' },
      environments,
    });
    expect(run).toContain('### Environments');
    expect(run).toContain('admin@example.com');
    expect(run).not.toContain('hunter2-admin');
    const authoring = buildQaAuthoringSeed({
      project: { id: 'proj', name: 'Proj' },
      plan,
      context: { epic: null, card: null },
      environments,
    });
    expect(authoring).toContain('### Environments');
  });
});

describe('qaStepGuard across steps', () => {
  /** A fake browser host that remembers what was typed and echoes it later. */
  function fakeHost() {
    let field = '';
    return async (op: string, text: string | undefined) => {
      if (op === 'type') {
        field = text ?? '';
        return { markdown: 'Browser: type ok', hostDetail: 'locator', ui: { summary: 'Typed' } };
      }
      return {
        markdown: `Page text: Password ${field} (shown)`,
        hostDetail: 'read_page',
        ui: { summary: 'Read page', extractPreview: [`value=${field}`] },
      };
    };
  }

  async function step(
    host: ReturnType<typeof fakeHost>,
    sessionMode: string | null,
    op: string,
    text?: string,
  ) {
    const guard = qaStepGuard({ sessionMode, projectId: 'proj', op, text });
    if (!guard.ok) throw new Error(guard.error);
    return guard.redact(await host(op, guard.text));
  }

  it('types the real password and redacts it from a later, separate observation', async () => {
    const env = staging();
    const host = fakeHost();
    const typed = await step(host, 'qa', 'type', qaPasswordPlaceholder(env.accounts[0].id));
    expect(JSON.stringify(typed)).not.toContain('hunter2-admin');
    // The page now shows the password; a read_page step that typed nothing
    // must still come back scrubbed.
    const read = await step(host, 'qa', 'read_page');
    expect(read.markdown).toBe('Page text: Password *** (shown)');
    expect(read.ui).toEqual({ summary: 'Read page', extractPreview: ['value=***'] });
  });

  it('also redacts a short password echoed later', async () => {
    const env = createQaEnvironment('proj', {
      name: 'Dev',
      accounts: [{ label: 'Pin', username: 'u', password: '42' }],
    });
    const host = fakeHost();
    await step(host, 'qa', 'type', qaPasswordPlaceholder(env.accounts[0].id));
    expect((await step(host, 'qa', 'read_page')).markdown).not.toContain('42');
  });

  it('leaves results of non-QA sessions untouched', async () => {
    staging();
    const guard = qaStepGuard({
      sessionMode: null,
      projectId: 'proj',
      op: 'read_page',
      text: undefined,
    });
    expect(guard.ok).toBe(true);
    const r = { markdown: 'hunter2-admin' };
    expect(guard.ok && guard.redact(r)).toBe(r);
  });
});
