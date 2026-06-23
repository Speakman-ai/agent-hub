import { describe, it, expect } from 'vitest';
import {
  AUTH_MODEL_ENGINE_ORDER,
  firstEngineWithAuthenticatedModels,
  defaultModelForAuthenticatedEngine,
} from './authModelEngines';

describe('authModelEngines', () => {
  it('picks the first engine in stable order that has models', () => {
    const mc = {
      engineValidModels: {
        'claude-code': [],
        'cursor-agent': ['composer-2.5'],
        'codex-cli': ['gpt-5.3-codex'],
      },
    };
    expect(firstEngineWithAuthenticatedModels(mc)).toBe('cursor-agent');
  });

  it('prefers claude when it is authenticated', () => {
    const mc = {
      engineValidModels: {
        'claude-code': ['claude-opus-4-8'],
        'cursor-agent': ['composer-2.5'],
      },
    };
    expect(firstEngineWithAuthenticatedModels(mc)).toBe('claude-code');
  });

  it('returns null when no engine has models', () => {
    expect(
      firstEngineWithAuthenticatedModels({
        engineValidModels: { 'claude-code': [], 'cursor-agent': [] },
      }),
    ).toBeNull();
  });

  it('defaultModelForAuthenticatedEngine prefers server default then first valid', () => {
    expect(
      defaultModelForAuthenticatedEngine(
        {
          engineDefaultModels: { 'claude-code': 'claude-sonnet-4-6' },
          engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'] },
        },
        'claude-code',
      ),
    ).toBe('claude-sonnet-4-6');
    expect(
      defaultModelForAuthenticatedEngine(
        { engineDefaultModels: { 'claude-code': '' }, engineValidModels: { 'claude-code': ['x'] } },
        'claude-code',
      ),
    ).toBe('x');
  });

  it('AUTH_MODEL_ENGINE_ORDER lists primary UI engines only', () => {
    expect(AUTH_MODEL_ENGINE_ORDER!).toEqual(['claude-code', 'cursor-agent', 'codex-cli']);
  });
});
