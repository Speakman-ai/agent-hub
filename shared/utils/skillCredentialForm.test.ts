import { describe, expect, it } from 'vitest';
import {
  findCredentialRow,
  isSecretCredential,
  validateCredentialValue,
  type SkillCredentialRow,
} from './skillCredentialForm';

describe('skillCredentialForm', () => {
  describe('findCredentialRow', () => {
    const rows: SkillCredentialRow[] = [
      { id: '1', key_name: 'LINEAR_API_KEY', masked_preview: 'lin_…abcd' },
      { id: '2', key_name: 'OPENAI_API_KEY', masked_preview: 'sk-…wxyz' },
    ];

    it('returns the row whose key_name matches', () => {
      expect(findCredentialRow(rows, 'OPENAI_API_KEY')?.id).toBe('2');
    });

    it('returns undefined when no row matches', () => {
      expect(findCredentialRow(rows, 'MISSING')).toBeUndefined();
    });

    it('is null/shape-safe', () => {
      expect(findCredentialRow(null, 'X')).toBeUndefined();
      expect(findCredentialRow(undefined, 'X')).toBeUndefined();
      expect(findCredentialRow([] as SkillCredentialRow[], 'X')).toBeUndefined();
    });
  });

  describe('isSecretCredential', () => {
    it('treats secret and json as masked', () => {
      expect(isSecretCredential({ name: 'A', type: 'secret' })).toBe(true);
      expect(isSecretCredential({ name: 'B', type: 'json' })).toBe(true);
    });

    it('treats text/undefined as plaintext', () => {
      expect(isSecretCredential({ name: 'C', type: 'text' })).toBe(false);
      expect(isSecretCredential({ name: 'D' })).toBe(false);
      expect(isSecretCredential(null)).toBe(false);
    });
  });

  describe('validateCredentialValue', () => {
    it('blocks a blank required value', () => {
      expect(validateCredentialValue({ name: 'K', required: true }, '')).toMatch(/required/);
      expect(validateCredentialValue({ name: 'K', required: true }, '   ')).toMatch(/required/);
      expect(validateCredentialValue({ name: 'K', required: true }, null)).toMatch(/required/);
      expect(validateCredentialValue({ name: 'K', required: true }, undefined)).toMatch(/required/);
    });

    it('allows a non-blank required value', () => {
      expect(validateCredentialValue({ name: 'K', required: true }, 'lin_123')).toBeNull();
    });

    it('allows a blank optional value', () => {
      expect(validateCredentialValue({ name: 'K', required: false }, '')).toBeNull();
      expect(validateCredentialValue({ name: 'K' }, '')).toBeNull();
      expect(validateCredentialValue(null, '')).toBeNull();
    });
  });
});
