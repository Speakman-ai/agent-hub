/**
 * deploy.yaml `preview:` block: parse + validation (pure) and secret-name
 * resolution against the preview secrets store (DB-backed).
 */
import '../test/setup.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseDeployConfig, DeployConfigError } from './deploy-config.js';
import {
  PREVIEW_DEFAULT_HEALTH_PATH,
  PREVIEW_DEFAULT_HEALTH_TIMEOUT_MINUTES,
} from './deploy-preview-config.js';
import { previewToEnvironmentSpec } from '../preview/pr-environment-runner-runtime.js';
import {
  findMissingPreviewSecrets,
  resolvePreviewSecretEnv,
  validatePreviewSecretRefs,
} from './deploy-preview-secrets.js';
import { replacePreviewSecrets, listPreviewSecretAudit } from '../preview/preview-secrets-store.js';
import { getDb } from '../db.js';

const PROJECT_ID = 'proj-deploy-preview';

const FULL = `
version: 1
preview:
  compose: docker-compose.preview.yml
  service: app
  port: 3000
  health: /healthz
  health_timeout_minutes: 40
  steps:
    - name: migrate
      run: docker compose -f docker-compose.preview.yml exec -T app npm run db:migrate
    - run: docker compose -f docker-compose.preview.yml exec -T app npm run db:seed
  secrets:
    - POSTGRES_PASSWORD
    - STRIPE_TEST_KEY
environments:
  production:
    steps:
      - run: ./deploy.sh
`;

function previewDoc(body: string): string {
  return `version: 1\npreview:\n${body}`;
}

function reasonOf(yaml: string): string {
  try {
    parseDeployConfig(yaml);
  } catch (err) {
    expect(err).toBeInstanceOf(DeployConfigError);
    return (err as DeployConfigError).reason;
  }
  throw new Error('expected parseDeployConfig to throw');
}

describe('parseDeployConfig: preview block', () => {
  it('parses every field alongside environments', () => {
    const cfg = parseDeployConfig(FULL);
    expect(cfg.preview).toEqual({
      compose: 'docker-compose.preview.yml',
      service: 'app',
      port: 3000,
      health: '/healthz',
      healthTimeoutMinutes: 40,
      steps: [
        {
          name: 'migrate',
          run: 'docker compose -f docker-compose.preview.yml exec -T app npm run db:migrate',
        },
        {
          name: 'step 2',
          run: 'docker compose -f docker-compose.preview.yml exec -T app npm run db:seed',
        },
      ],
      secrets: ['POSTGRES_PASSWORD', 'STRIPE_TEST_KEY'],
    });
    expect([...cfg.environments.keys()]).toEqual(['production']);
  });

  it('is null when omitted', () => {
    const cfg = parseDeployConfig(
      'version: 1\nenvironments:\n  dev:\n    steps:\n      - run: x\n',
    );
    expect(cfg.preview).toBeNull();
  });

  it('defaults health, steps, and secrets and allows a preview-only file', () => {
    const cfg = parseDeployConfig(
      previewDoc('  compose: ./ops/compose.yml\n  service: web\n  port: 8080\n'),
    );
    expect(cfg.environments.size).toBe(0);
    expect(cfg.preview).toMatchObject({
      compose: 'ops/compose.yml',
      health: PREVIEW_DEFAULT_HEALTH_PATH,
      healthTimeoutMinutes: PREVIEW_DEFAULT_HEALTH_TIMEOUT_MINUTES,
      steps: [],
      secrets: [],
    });
  });

  it('carries health_timeout_minutes into the runner spec as healthTimeoutMs', () => {
    const cfg = parseDeployConfig(FULL);
    expect(previewToEnvironmentSpec(cfg.preview!, 1591).healthTimeoutMs).toBe(40 * 60_000);
    const dflt = parseDeployConfig(previewDoc('  compose: c.yml\n  service: web\n  port: 80\n'));
    expect(previewToEnvironmentSpec(dflt.preview!, 1).healthTimeoutMs).toBe(5 * 60_000);
  });

  it('still requires environments when there is no preview block', () => {
    expect(reasonOf('version: 1\n')).toBe('missing_environments');
  });

  it.each([
    ['compose', '  service: app\n  port: 3000\n', 'missing_preview_compose'],
    ['service', '  compose: c.yml\n  port: 3000\n', 'missing_preview_service'],
    ['port', '  compose: c.yml\n  service: app\n', 'missing_preview_port'],
  ])('rejects a missing %s with a typed error', (_field, body, reason) => {
    expect(reasonOf(previewDoc(body))).toBe(reason);
  });

  it.each([
    [
      'absolute compose path',
      '  compose: /etc/c.yml\n  service: app\n  port: 1\n',
      'invalid_preview_compose',
    ],
    [
      'compose escaping the repo',
      '  compose: ../c.yml\n  service: app\n  port: 1\n',
      'invalid_preview_compose',
    ],
    ['empty service', '  compose: c.yml\n  service: ""\n  port: 1\n', 'invalid_preview_service'],
    ['string port', '  compose: c.yml\n  service: app\n  port: "3000"\n', 'invalid_preview_port'],
    [
      'out-of-range port',
      '  compose: c.yml\n  service: app\n  port: 70000\n',
      'invalid_preview_port',
    ],
    [
      'relative health',
      '  compose: c.yml\n  service: app\n  port: 1\n  health: healthz\n',
      'invalid_preview_health',
    ],
    [
      'zero health timeout',
      '  compose: c.yml\n  service: app\n  port: 1\n  health_timeout_minutes: 0\n',
      'invalid_preview_health_timeout',
    ],
    [
      'health timeout above the cap',
      '  compose: c.yml\n  service: app\n  port: 1\n  health_timeout_minutes: 61\n',
      'invalid_preview_health_timeout',
    ],
    [
      'fractional health timeout',
      '  compose: c.yml\n  service: app\n  port: 1\n  health_timeout_minutes: 1.5\n',
      'invalid_preview_health_timeout',
    ],
    [
      'non-list steps',
      '  compose: c.yml\n  service: app\n  port: 1\n  steps: x\n',
      'invalid_preview_steps',
    ],
    [
      'step without run',
      '  compose: c.yml\n  service: app\n  port: 1\n  steps:\n    - name: seed\n',
      'missing_run',
    ],
    [
      'unknown step key',
      '  compose: c.yml\n  service: app\n  port: 1\n  steps:\n    - run: x\n      shell: sh\n',
      'unknown_key',
    ],
    [
      'unknown preview key',
      '  compose: c.yml\n  service: app\n  port: 1\n  ports: [1]\n',
      'unknown_key',
    ],
    [
      'non-list secrets',
      '  compose: c.yml\n  service: app\n  port: 1\n  secrets: FOO\n',
      'invalid_preview_secrets',
    ],
    [
      'bad secret name',
      '  compose: c.yml\n  service: app\n  port: 1\n  secrets: [has-dash]\n',
      'invalid_preview_secrets',
    ],
    [
      'reserved secret name',
      '  compose: c.yml\n  service: app\n  port: 1\n  secrets: [AGENT_HUB_API_KEY]\n',
      'invalid_preview_secrets',
    ],
    [
      'duplicate secret',
      '  compose: c.yml\n  service: app\n  port: 1\n  secrets: [A, A]\n',
      'invalid_preview_secrets',
    ],
  ])('rejects %s', (_label, body, reason) => {
    expect(reasonOf(previewDoc(body))).toBe(reason);
  });

  it('rejects a non-mapping preview block', () => {
    expect(reasonOf('version: 1\npreview: yes\n')).toBe('invalid_preview');
  });
});

describe('preview secret resolution', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ?`).run(PROJECT_ID);
    db.prepare(`DELETE FROM worktree_preview_secret_audit WHERE project_id = ?`).run(PROJECT_ID);
  });

  const preview = parseDeployConfig(FULL).preview!;

  it('resolves only the referenced names from the store', () => {
    replacePreviewSecrets(PROJECT_ID, [
      { key: 'POSTGRES_PASSWORD', value: 'pg-secret', kind: 'secret' },
      { key: 'STRIPE_TEST_KEY', value: 'sk_test_1', kind: 'secret' },
      { key: 'UNRELATED', value: 'nope', kind: 'plain' },
    ]);
    expect(findMissingPreviewSecrets(preview, PROJECT_ID)).toEqual([]);
    expect(resolvePreviewSecretEnv(preview, PROJECT_ID, { sessionId: 's1' })).toEqual({
      POSTGRES_PASSWORD: 'pg-secret',
      STRIPE_TEST_KEY: 'sk_test_1',
    });
    const reads = listPreviewSecretAudit(PROJECT_ID).filter((a) => a.action === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.keys).toBe('POSTGRES_PASSWORD|STRIPE_TEST_KEY');
  });

  it('fails validation on unknown names without leaking stored values', () => {
    replacePreviewSecrets(PROJECT_ID, [
      { key: 'POSTGRES_PASSWORD', value: 'pg-secret-value', kind: 'secret' },
    ]);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');

    expect(findMissingPreviewSecrets(preview, PROJECT_ID)).toEqual(['STRIPE_TEST_KEY']);
    let caught: unknown;
    try {
      resolvePreviewSecretEnv(preview, PROJECT_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeployConfigError);
    expect((caught as DeployConfigError).reason).toBe('unknown_preview_secret');
    expect((caught as Error).message).toContain('"STRIPE_TEST_KEY"');
    expect((caught as Error).message).not.toContain('pg-secret-value');
    expect(() => validatePreviewSecretRefs(preview, PROJECT_ID)).toThrow(DeployConfigError);

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(' ');
    expect(logged).not.toContain('pg-secret-value');
    // Validation failed before any decrypt, so nothing was read.
    expect(listPreviewSecretAudit(PROJECT_ID).filter((a) => a.action === 'read')).toHaveLength(0);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  describe('names that shadow Object.prototype members', () => {
    const protoPreview = parseDeployConfig(
      previewDoc(
        '  compose: c.yml\n  service: app\n  port: 1\n  secrets: [__proto__, constructor, toString]\n',
      ),
    ).preview!;

    it('parses them as ordinary secret names', () => {
      expect(protoPreview.secrets).toEqual(['__proto__', 'constructor', 'toString']);
    });

    it('resolves them as own properties of the env map', () => {
      replacePreviewSecrets(PROJECT_ID, [
        { key: '__proto__', value: 'proto-value', kind: 'secret' },
        { key: 'constructor', value: 'ctor-value', kind: 'secret' },
        { key: 'toString', value: 'tostring-value', kind: 'secret' },
      ]);
      const env = resolvePreviewSecretEnv(protoPreview, PROJECT_ID);
      expect(Object.hasOwn(env, '__proto__')).toBe(true);
      expect(env['__proto__']).toBe('proto-value');
      expect(Object.hasOwn(env, 'constructor')).toBe(true);
      expect(env['constructor']).toBe('ctor-value');
      expect(Object.hasOwn(env, 'toString')).toBe(true);
      expect(env['toString']).toBe('tostring-value');
    });

    it.each(['__proto__', 'constructor', 'toString'])(
      'fails when %s is stored but its ciphertext is corrupt',
      (corrupted) => {
        replacePreviewSecrets(PROJECT_ID, [
          { key: '__proto__', value: 'proto-value', kind: 'secret' },
          { key: 'constructor', value: 'ctor-value', kind: 'secret' },
          { key: 'toString', value: 'tostring-value', kind: 'secret' },
        ]);
        getDb()
          .prepare(
            `UPDATE worktree_preview_secrets SET value_ciphertext = 'not-a-valid-blob'
              WHERE project_id = ? AND key = ?`,
          )
          .run(PROJECT_ID, corrupted);

        let caught: unknown;
        try {
          resolvePreviewSecretEnv(protoPreview, PROJECT_ID);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DeployConfigError);
        expect((caught as DeployConfigError).reason).toBe('unknown_preview_secret');
        expect((caught as Error).message).toContain(`"${corrupted}"`);
        expect((caught as Error).message).not.toContain('-value');
      },
    );
  });
});
