import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  isOnboardingComplete,
  markOnboardingComplete,
  markOnboardingIncomplete,
} from './onboarding-complete.js';
import { setAuthFilePathForTests, reloadAuthRecord, saveAuthRecord } from './auth-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ah-onboarding-'));
  mkdirSync(dir, { recursive: true });
  setAuthFilePathForTests(path.join(dir, 'auth.json'));
  reloadAuthRecord();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('onboarding-complete', () => {
  it('is false on a truly fresh install (no auth, no flag)', () => {
    expect(isOnboardingComplete(dir)).toBe(false);
  });

  it('defaults to true for legacy installs that already have an Owner and no flag', () => {
    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();
    expect(isOnboardingComplete(dir)).toBe(true);
  });

  it('markOnboardingIncomplete wins over the legacy default', () => {
    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();
    markOnboardingIncomplete(dir);
    expect(isOnboardingComplete(dir)).toBe(false);
    const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(cfg.onboardingComplete).toBe(false);
  });

  it('markOnboardingComplete flips the flag to true', () => {
    markOnboardingIncomplete(dir);
    markOnboardingComplete(dir);
    expect(isOnboardingComplete(dir)).toBe(true);
  });

  it('respects an explicit true already on disk', () => {
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ onboardingComplete: true }, null, 2),
    );
    expect(isOnboardingComplete(dir)).toBe(true);
  });
});
