import { describe, it, expect } from 'vitest';
import { isSetupWizardSession, SETUP_WIZARD_SESSION_PREFIXES } from './setup-wizard-session.js';

describe('isSetupWizardSession', () => {
  it('matches every guided setup-wizard prefix', () => {
    expect(isSetupWizardSession({ name: '[Preview Setup] Acme' })).toBe(true);
    expect(isSetupWizardSession({ name: '[Finalize Setup] Acme' })).toBe(true);
    expect(isSetupWizardSession({ name: '[RUM Setup] Acme' })).toBe(true);
    expect(isSetupWizardSession({ name: '[Deploy Setup] Acme' })).toBe(true);
    expect(isSetupWizardSession({ name: '[Logs Setup] Acme' })).toBe(true);
    expect(isSetupWizardSession({ name: '[Infra Setup] Acme' })).toBe(true);
  });

  it('keeps the prefix list in sync with the matcher', () => {
    for (const prefix of SETUP_WIZARD_SESSION_PREFIXES) {
      expect(isSetupWizardSession({ name: `${prefix} whatever` })).toBe(true);
    }
  });

  it('does not match normal chat sessions or other scoped sessions', () => {
    expect(isSetupWizardSession({ name: 'Fix the importer bug' })).toBe(false);
    expect(isSetupWizardSession({ name: '[Design Fwd] Landing page' })).toBe(false);
    expect(isSetupWizardSession({ name: '[Skill from] something' })).toBe(false);
    // A prefix that merely contains "Setup" mid-string must not match.
    expect(isSetupWizardSession({ name: 'Project Setup notes' })).toBe(false);
  });

  it('is null/undefined-safe', () => {
    expect(isSetupWizardSession(null)).toBe(false);
    expect(isSetupWizardSession(undefined)).toBe(false);
    expect(isSetupWizardSession({})).toBe(false);
    expect(isSetupWizardSession({ name: null })).toBe(false);
  });
});
