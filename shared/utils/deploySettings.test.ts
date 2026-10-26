import { describe, expect, it } from 'vitest';
import {
  deployDocumentToForm,
  deployFormToDocument,
  emptyDeployEnvironment,
  emptyDeployPreview,
  emptyDeployStep,
  previewDocumentToForm,
  previewFormToDocument,
} from './deploySettings';

const DOC = {
  production: {
    approval: true,
    'runs-on': 'ubuntu-24.04',
    timeout_minutes: 30,
    origin: 'https://app.example.com',
    readiness: 'https://app.example.com/health',
    steps: [
      {
        name: 'trigger-release-all',
        github_workflow: { workflow: 'release-all.yml', ref: 'main', inputs: { bump: 'patch' } },
      },
      { name: 'smoke', run: './smoke.sh' },
    ],
  },
};

describe('deploy settings form', () => {
  it('round-trips a document through the form', () => {
    const form = deployDocumentToForm(DOC);
    expect(form[0].steps[0]).toMatchObject({
      kind: 'github_workflow',
      inputs: [{ key: 'bump', value: 'patch' }],
    });
    const { document, errors } = deployFormToDocument(form);
    expect(errors).toEqual([]);
    expect(document).toEqual(DOC);
  });

  it('reports missing names, duplicates, empty commands and bad timeouts', () => {
    const a = emptyDeployEnvironment('dev');
    const b = { ...emptyDeployEnvironment('dev'), timeoutMinutes: '999' };
    const c = { ...emptyDeployEnvironment(''), steps: [] };
    const { errors } = deployFormToDocument([a, b, c]);
    expect(errors).toEqual([
      '"dev" step 1: command is required.',
      '"dev": duplicate environment name.',
      '"dev": timeout must be a whole number of minutes from 1 to 240.',
      '"dev" step 1: command is required.',
      'Environment 3: name is required.',
      'Environment 3: add at least one step.',
    ]);
  });

  it('keeps multiline and whitespace-significant workflow inputs verbatim', () => {
    const doc = {
      prod: {
        approval: false,
        'runs-on': 'ubuntu-24.04',
        timeout_minutes: 60,
        steps: [
          {
            name: 'release',
            github_workflow: {
              workflow: 'r.yml',
              ref: 'main',
              inputs: { notes: 'line one\nline two\n', pad: '  spaced  ', empty: '' },
            },
          },
        ],
      },
    };
    const { document, errors } = deployFormToDocument(deployDocumentToForm(doc));
    expect(errors).toEqual([]);
    expect(document).toEqual(doc);
  });

  it('rejects an input with a value but no name, and duplicate names', () => {
    const env = emptyDeployEnvironment('prod');
    env.steps = [
      {
        ...emptyDeployStep('github_workflow'),
        workflow: 'r.yml',
        inputs: [
          { key: ' bump ', value: 'minor' },
          { key: '', value: '' },
          { key: '', value: 'x' },
          { key: 'bump', value: 'major' },
        ],
      },
    ];
    const { errors } = deployFormToDocument([env]);
    expect(errors).toEqual([
      '"prod" step 1: a workflow input has a value but no name.',
      '"prod" step 1: workflow input "bump" is listed twice.',
    ]);
  });
});

describe('names that collide with Object.prototype', () => {
  const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

  it('round-trips environments and workflow inputs with those names', () => {
    const doc = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          NAMES.map((name) => [
            name,
            {
              approval: false,
              'runs-on': 'ubuntu-24.04',
              timeout_minutes: 60,
              steps: [
                {
                  name: 'release',
                  github_workflow: {
                    workflow: 'r.yml',
                    ref: 'main',
                    inputs: Object.fromEntries(NAMES.map((input) => [input, `v-${input}`])),
                  },
                },
              ],
            },
          ]),
        ),
      ),
    );
    expect(Object.keys(doc)).toEqual(NAMES);
    const form = deployDocumentToForm(doc);
    expect(form.map((env) => env.name)).toEqual(NAMES);
    const { document, errors } = deployFormToDocument(form);
    expect(errors).toEqual([]);
    expect(Object.keys(document)).toEqual(NAMES);
    const wire = JSON.parse(JSON.stringify(document));
    expect(Object.keys(wire)).toEqual(NAMES);
    expect(Object.keys(wire.__proto__.steps[0].github_workflow.inputs)).toEqual(NAMES);
    expect(wire.constructor.steps[0].github_workflow.inputs.toString).toBe('v-toString');
  });

  it('still detects real duplicates of those names', () => {
    const { errors } = deployFormToDocument([
      { ...emptyDeployEnvironment('constructor'), steps: [{ ...emptyDeployStep(), run: 'x' }] },
      { ...emptyDeployEnvironment('constructor'), steps: [{ ...emptyDeployStep(), run: 'x' }] },
    ]);
    expect(errors).toEqual(['"constructor": duplicate environment name.']);
  });
});

describe('preview form', () => {
  const PREVIEW = {
    compose: 'docker-compose.preview.yml',
    service: 'app',
    port: 3000,
    health: '/healthz',
    health_timeout_minutes: 40,
    steps: [{ name: 'migrate', run: 'docker compose exec -T app npm run db:migrate' }],
    secrets: ['DATABASE_PASSWORD'],
  };

  it('round-trips a preview block', () => {
    const form = previewDocumentToForm(PREVIEW);
    expect(form.enabled).toBe(true);
    expect(previewFormToDocument(form)).toEqual({ preview: PREVIEW, errors: [] });
  });

  it('disabled means no preview block', () => {
    expect(previewFormToDocument(previewDocumentToForm(null))).toEqual({
      preview: null,
      errors: [],
    });
  });

  it('reports missing required fields', () => {
    const form = { ...emptyDeployPreview(), enabled: true, healthTimeoutMinutes: '99' };
    expect(previewFormToDocument(form).errors).toEqual([
      'PR environments: compose file is required.',
      'PR environments: service is required.',
      'PR environments: port must be a whole number from 1 to 65535.',
      'PR environments: health timeout must be a whole number of minutes from 1 to 60.',
    ]);
  });
});
