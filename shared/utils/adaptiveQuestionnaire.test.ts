import { describe, it, expect } from 'vitest';
import {
  IDK,
  STEP_IDS,
  initialDraft,
  isDescriptionValid,
  isIdk,
  visibleSteps,
  currentVisibleStep,
  canContinue,
  advance,
  goBack,
  recommendedStack,
  stackOptionsFor,
  toProvisioningPayload,
} from './adaptiveQuestionnaire';

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

  describe('visibleSteps', () => {
    it('is the fixed description → hosting → name → review sequence', () => {
      expect(visibleSteps(initialDraft())).toEqual([
        'description',
        'hosting',
        'identity',
        'review',
      ]);
    });
  });

  describe('canContinue', () => {
    it('blocks step 1 until description is non-empty — no idk allowed', () => {
      const d = initialDraft();
      expect(canContinue(d)).toBe(false);
      expect(canContinue({ ...d, description: '   ' })).toBe(false);
      expect(canContinue({ ...d, description: 'a thing' })).toBe(true);
    });

    it('allows continue on hosting because Agent Hub is pre-selected', () => {
      const d = {
        ...initialDraft(),
        step: STEP_IDS.indexOf('hosting'),
        description: 'a thing',
      };
      expect(d.hosting).toBe('agenthub');
      expect(canContinue(d)).toBe(true);
      expect(canContinue({ ...d, hosting: IDK })).toBe(true);
      expect(canContinue({ ...d, hosting: null })).toBe(false);
    });

    it('requires a name (or idk) and a visibility on identity', () => {
      const atIdentity = (patch: any) => ({
        ...initialDraft(),
        step: STEP_IDS.indexOf('identity'),
        description: 'a thing',
        ...patch,
      });
      expect(canContinue(atIdentity({ name: 'acme', visibility: 'private' }))).toBe(true);
      expect(canContinue(atIdentity({ name: IDK, visibility: IDK }))).toBe(true);
      expect(canContinue(atIdentity({ name: '', visibility: 'private' }))).toBe(false);
      expect(canContinue(atIdentity({ name: 'x', visibility: null }))).toBe(false);
    });

    it('always allows continue on the review step', () => {
      const d = { ...initialDraft(), step: STEP_IDS.indexOf('review') };
      expect(canContinue(d)).toBe(true);
    });
  });

  describe('advance / goBack', () => {
    it('advances description → hosting → identity → review', () => {
      let d = { ...initialDraft(), description: 'thing' };
      d = advance(d);
      expect(STEP_IDS[d.step]).toBe('hosting');
      d = advance({ ...d, hosting: 'agenthub' });
      expect(STEP_IDS[d.step]).toBe('identity');
      d = advance({ ...d, name: 'acme', visibility: 'private' });
      expect(STEP_IDS[d.step]).toBe('review');
      const same = advance(d);
      expect(same!).toEqual(d);
    });

    it('goBack walks the same sequence in reverse', () => {
      const d = {
        ...initialDraft(),
        description: 'thing',
        step: STEP_IDS.indexOf('identity'),
      };
      const prev = goBack(d);
      expect(STEP_IDS[prev.step]).toBe('hosting');
      expect(STEP_IDS[goBack(prev).step]).toBe('description');
    });

    it('goBack is a no-op on step 0', () => {
      const d = initialDraft();
      expect(goBack(d)).toEqual(d);
    });
  });

  describe('currentVisibleStep', () => {
    it('maps the raw step pointer onto the visible sequence', () => {
      const d = {
        ...initialDraft(),
        step: STEP_IDS.indexOf('identity'),
      };
      expect(currentVisibleStep(d)).toBe(2);
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
    it('trims description, defers stack to the first build session, and defaults hosting to Hub', () => {
      const draft = {
        ...initialDraft(),
        description: '  a python CLI  ',
        name: IDK,
        visibility: 'private',
      };
      expect(toProvisioningPayload(draft)).toEqual({
        version: 2,
        description: 'a python CLI',
        appType: IDK,
        stack: IDK,
        integrations: IDK,
        authDetail: null,
        name: IDK,
        visibility: 'private',
        hostOnAgentHub: true,
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
