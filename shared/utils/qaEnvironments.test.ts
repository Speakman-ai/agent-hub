import { describe, expect, it } from 'vitest';
import {
  draftFromQaEnvironment,
  emptyQaAccount,
  emptyQaEnvironment,
  matchQaEnvironment,
  selectableQaEnvironments,
  QA_PASSWORD_MASK,
  qaEnvironmentDraftToInput,
  validateQaEnvironmentDraft,
} from './qaEnvironments';

const saved = {
  id: 'env-1',
  projectId: 'p',
  name: 'Staging',
  baseUrl: 'https://staging.example.com',
  notes: 'nightly seed',
  position: 0,
  createdAt: '',
  updatedAt: '',
  accounts: [
    {
      id: 'acc_1',
      label: 'Admin',
      username: 'a@x.com',
      password: QA_PASSWORD_MASK,
      hasPassword: true,
      notes: '',
    },
    {
      id: 'acc_2',
      label: 'Viewer',
      username: 'v@x.com',
      password: '',
      hasPassword: false,
      notes: '',
    },
  ],
};

describe('qaEnvironmentDraftToInput', () => {
  it('omits untouched saved passwords so the server keeps them', () => {
    const input = qaEnvironmentDraftToInput(draftFromQaEnvironment(saved));
    expect(input.accounts[0]).toEqual({
      id: 'acc_1',
      label: 'Admin',
      username: 'a@x.com',
      notes: '',
    });
    expect(input.accounts[1]).toMatchObject({ id: 'acc_2', password: '' });
  });

  it('sends typed and cleared passwords', () => {
    const d = draftFromQaEnvironment(saved);
    d.accounts[0].password = '';
    d.accounts[1].password = 'new-pw';
    const input = qaEnvironmentDraftToInput(d);
    expect(input.accounts[0].password).toBe('');
    expect(input.accounts[1].password).toBe('new-pw');
  });

  it('drops blank unsaved account rows', () => {
    const d = emptyQaEnvironment();
    d.name = 'Dev';
    d.accounts.push(emptyQaAccount());
    expect(qaEnvironmentDraftToInput(d).accounts).toEqual([]);
  });
});

describe('validateQaEnvironmentDraft', () => {
  it('requires a name, a valid URL, and labels on filled accounts', () => {
    const d = emptyQaEnvironment();
    expect(validateQaEnvironmentDraft(d)).toMatch(/Name/);
    d.name = 'Dev';
    d.baseUrl = 'staging.example.com';
    expect(validateQaEnvironmentDraft(d)).toMatch(/Base URL/);
    d.baseUrl = 'https://staging.example.com';
    d.accounts[0].username = 'someone';
    expect(validateQaEnvironmentDraft(d)).toMatch(/Account 1 needs a label/);
    d.accounts[0].label = 'Admin';
    expect(validateQaEnvironmentDraft(d)).toBeNull();
  });
});

describe('matchQaEnvironment', () => {
  const env = (id: string, baseUrl: string) => ({ ...saved, id, name: id, baseUrl });
  const envs = [
    env('none', ''),
    env('staging', 'https://staging.example.com/app'),
    env('prod', 'https://example.com'),
  ];

  it('offers only environments with a base URL', () => {
    expect(selectableQaEnvironments(envs).map((e) => e.id)).toEqual(['staging', 'prod']);
  });

  it('matches an exact base URL, then the same origin', () => {
    expect(matchQaEnvironment(envs, 'https://staging.example.com/app')?.id).toBe('staging');
    expect(matchQaEnvironment(envs, 'https://staging.example.com/login')?.id).toBe('staging');
    expect(matchQaEnvironment(envs, 'https://example.com/x')?.id).toBe('prod');
  });

  it('returns null for a custom or invalid URL', () => {
    expect(matchQaEnvironment(envs, 'https://other.example.com')).toBeNull();
    expect(matchQaEnvironment(envs, 'nope')).toBeNull();
    expect(matchQaEnvironment(envs, '')).toBeNull();
  });
});
