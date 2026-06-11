import { describe, it, expect } from 'vitest';
import {
  IDK,
  STEP_IDS,
  initialDraft,
  isDescriptionValid,
  isIdk,
  shouldShowAuthStep,
  visibleSteps,
  currentVisibleStep,
  canContinue,
  advance,
  goBack,
  recommendedStack,
  stackOptionsFor,
  toProvisioningPayload,
} from './adaptiveQuestionnaire.js';

describe('adaptiveQuestionnaire — pure helpers', () => {
  describe('isDescriptionValid', () => {
    it('rejects empty strings, whitespace, and non-strings', () => {
      expect(isDescriptionValid('')).toBe(false);
      expect(isDescriptionValid('   ')).toBe(false);
      expect(isDescriptionValid(null)).toBe(false);
      expect(isDescriptionValid(undefined)).toBe(false);
      expect(isDescriptionValid(42)).toBe(false);
    });

    it('accepts any non-empty trimmed string', () => {
      expect(isDescriptionValid('a survey tool')).toBe(true);
      expect(isDescriptionValid('  spaces-around  ')).toBe(true);
    });
  });

  describe('isIdk', () => {
    it('detects the idk sentinel directly', () => {
      expect(isIdk(IDK)).toBe(true);
      expect(isIdk('idk')).toBe(true);
    });

    it('treats objects whose values are all idk as idk', () => {
      expect(isIdk({ provider: IDK, userModel: IDK })).toBe(true);
    });

    it('returns false for concrete values, arrays, null', () => {
      expect(isIdk('web-app')).toBe(false);
      expect(isIdk(['github'])).toBe(false);
      expect(isIdk(null)).toBe(false);
      expect(isIdk({ provider: 'oauth', userModel: IDK })).toBe(false);
    });
  });

  describe('shouldShowAuthStep / visibleSteps', () => {
    it('skips auth when user picks idk for integrations', () => {
      expect(shouldShowAuthStep(IDK)).toBe(false);
      const d = { ...initialDraft(), integrations: IDK };
      expect(visibleSteps(d)).not.toContain('auth');
    });

    it('skips auth when integrations is an explicit list without auth', () => {
      expect(shouldShowAuthStep(['github', 'db'])).toBe(false);
      const d = { ...initialDraft(), integrations: ['github', 'db'] };
      expect(visibleSteps(d)).not.toContain('auth');
    });

    it('shows auth when integrations explicitly includes auth', () => {
      expect(shouldShowAuthStep(['auth', 'db'])).toBe(true);
      const d = { ...initialDraft(), integrations: ['auth', 'db'] };
      expect(visibleSteps(d)).toContain('auth');
    });
  });

  describe('canContinue', () => {
    it('blocks step 1 until description is non-empty — no idk allowed', () => {
      const d = initialDraft();
      expect(canContinue(d)).toBe(false);
      expect(canContinue({ ...d, description: '   ' })).toBe(false);
      expect(canContinue({ ...d, description: 'a thing' })).toBe(true);
    });

    it('allows idk on every step past step 1', () => {
      // appType
      const atStep = (stepId, patch) => ({
        ...initialDraft(),
        step: STEP_IDS.indexOf(stepId),
        description: 'a thing',
        ...patch,
      });
      expect(canContinue(atStep('appType', { appType: IDK }))).toBe(true);
      expect(canContinue(atStep('appType', {}))).toBe(false);

      expect(canContinue(atStep('stack', { stack: IDK }))).toBe(true);
      expect(canContinue(atStep('stack', {}))).toBe(false);

      expect(canContinue(atStep('integrations', { integrations: IDK }))).toBe(true);
      expect(canContinue(atStep('integrations', { integrations: ['github'] }))).toBe(true);
      expect(canContinue(atStep('integrations', { integrations: [] }))).toBe(false);

      expect(canContinue(atStep('auth', { authDetail: IDK }))).toBe(true);
      expect(
        canContinue(atStep('auth', { authDetail: { provider: 'oauth', userModel: IDK } })),
      ).toBe(true);
      expect(canContinue(atStep('auth', {}))).toBe(false);

      expect(canContinue(atStep('identity', { name: 'acme', visibility: 'private' }))).toBe(true);
      expect(canContinue(atStep('identity', { name: IDK, visibility: IDK }))).toBe(true);
      expect(canContinue(atStep('identity', { name: '', visibility: 'private' }))).toBe(false);
      expect(canContinue(atStep('identity', { name: 'x', visibility: null }))).toBe(false);
    });

    it('always allows continue on the review step', () => {
      const d = { ...initialDraft(), step: STEP_IDS.indexOf('review') };
      expect(canContinue(d)).toBe(true);
    });
  });

  describe('advance / goBack', () => {
    it('advances through the visible sequence and skips auth when not selected', () => {
      let d = { ...initialDraft(), description: 'thing' };
      // desc -> appType
      d = advance(d);
      expect(STEP_IDS[d.step]).toBe('appType');
      // appType idk -> stack
      d = advance({ ...d, appType: IDK });
      expect(STEP_IDS[d.step]).toBe('stack');
      // stack idk -> integrations
      d = advance({ ...d, stack: IDK });
      expect(STEP_IDS[d.step]).toBe('integrations');
      // integrations without auth -> skip to hosting
      d = advance({ ...d, integrations: ['github'] });
      expect(STEP_IDS[d.step]).toBe('hosting');
      // hosting -> identity
      d = advance({ ...d, hosting: 'agenthub' });
      expect(STEP_IDS[d.step]).toBe('identity');
      // identity -> review
      d = advance({ ...d, name: 'acme', visibility: 'private' });
      expect(STEP_IDS[d.step]).toBe('review');
      // review is terminal
      const same = advance(d);
      expect(same).toEqual(d);
    });

    it('visits auth step when integrations includes auth', () => {
      let d = {
        ...initialDraft(),
        description: 'thing',
        step: STEP_IDS.indexOf('integrations'),
        integrations: ['auth', 'db'],
      };
      d = advance(d);
      expect(STEP_IDS[d.step]).toBe('auth');
      d = advance({ ...d, authDetail: IDK });
      expect(STEP_IDS[d.step]).toBe('hosting');
      d = advance({ ...d, hosting: IDK });
      expect(STEP_IDS[d.step]).toBe('identity');
    });

    it('goBack honors conditional skip', () => {
      // Sitting on identity after skipping auth — Back should return to integrations
      const d = {
        ...initialDraft(),
        description: 'thing',
        integrations: ['github'],
        step: STEP_IDS.indexOf('identity'),
      };
      const prev = goBack(d);
      expect(STEP_IDS[prev.step]).toBe('hosting');
      // hosting -> back -> integrations (auth still skipped)
      expect(STEP_IDS[goBack(prev).step]).toBe('integrations');
    });

    it('goBack is a no-op on step 0', () => {
      const d = initialDraft();
      expect(goBack(d)).toEqual(d);
    });
  });

  describe('currentVisibleStep', () => {
    it('maps raw step pointer through the skip rules', () => {
      const d = {
        ...initialDraft(),
        integrations: ['github'],
        step: STEP_IDS.indexOf('identity'),
      };
      // identity is the 6th visible step (0-based index 5 when auth skipped):
      // description, appType, stack, integrations, hosting, identity, review
      expect(currentVisibleStep(d)).toBe(5);
    });
  });

  describe('stack recommendations', () => {
    it('returns a recommended value per known app type', () => {
      expect(recommendedStack('web-app')).toBe('react-vite-express-sqlite');
      expect(recommendedStack('cli')).toBe('node-ts-commander');
    });

    it('returns null for unknown app type', () => {
      expect(recommendedStack('unknown')).toBeNull();
      expect(recommendedStack(IDK)).toBeNull();
    });

    it('exposes the full option list', () => {
      expect(stackOptionsFor('web-app').length).toBeGreaterThan(1);
      expect(stackOptionsFor('unknown')).toEqual([]);
    });
  });

  describe('toProvisioningPayload', () => {
    it('trims description and preserves idk markers', () => {
      const draft = {
        ...initialDraft(),
        description: '  a tool  ',
        appType: 'web-app',
        stack: 'react-vite-express-sqlite',
        integrations: ['github', 'auth'],
        authDetail: { provider: 'oauth', userModel: IDK },
        name: IDK,
        visibility: 'private',
      };
      expect(toProvisioningPayload(draft)).toEqual({
        version: 1,
        description: 'a tool',
        appType: 'web-app',
        stack: 'react-vite-express-sqlite',
        integrations: ['github', 'auth'],
        authDetail: { provider: 'oauth', userModel: IDK },
        name: IDK,
        visibility: 'private',
        hostOnAgentHub: true, // idk/unset hosting defaults to Agent Hub
        generationModel: null,
      });
    });

    it('hostOnAgentHub is false only for an explicit github choice', () => {
      const base = { ...initialDraft(), description: 'x' };
      expect(toProvisioningPayload({ ...base, hosting: 'github' }).hostOnAgentHub).toBe(false);
      expect(toProvisioningPayload({ ...base, hosting: 'agenthub' }).hostOnAgentHub).toBe(true);
      expect(toProvisioningPayload({ ...base, hosting: IDK }).hostOnAgentHub).toBe(true);
    });
  });
});
