import './test/setup.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureDevEmailUser, isDevEmailUserEnabled } from './dev-email-user.js';
import { getMembershipRole } from './memberships-store.js';
import { getActiveOrgId, initOrgsDb } from './orgs.js';
import { getUserByUsername } from './users-store.js';

const originalFlag = process.env.AGENT_HUB_DEV_EMAIL_USER;
const originalNodeEnv = process.env.NODE_ENV;

beforeAll(() => {
  initOrgsDb();
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.AGENT_HUB_DEV_EMAIL_USER;
  else process.env.AGENT_HUB_DEV_EMAIL_USER = originalFlag;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('isDevEmailUserEnabled', () => {
  it('is on only for the dev flag outside production', () => {
    expect(isDevEmailUserEnabled({ AGENT_HUB_DEV_EMAIL_USER: '1', NODE_ENV: 'development' })).toBe(
      true,
    );
    expect(isDevEmailUserEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(isDevEmailUserEnabled({ AGENT_HUB_DEV_EMAIL_USER: '1', NODE_ENV: 'production' })).toBe(
      false,
    );
  });
});

describe('ensureDevEmailUser', () => {
  it('returns null when the dev flag is off', () => {
    delete process.env.AGENT_HUB_DEV_EMAIL_USER;
    expect(ensureDevEmailUser()).toBeNull();
  });

  it('creates one email user and reuses that account', () => {
    process.env.AGENT_HUB_DEV_EMAIL_USER = '1';
    process.env.NODE_ENV = 'development';

    const first = ensureDevEmailUser();
    const second = ensureDevEmailUser();

    expect(first?.user.email).toMatch(/^dev-[0-9a-f]{12}@example\.com$/);
    expect(first?.user.needsEmailUpdate).toBe(false);
    expect(first?.user.role).toBe('Owner');
    expect(second?.user).toEqual(first?.user);
    expect(getUserByUsername(first!.user.email)?.id).toBe(first?.user.id);
    expect(getMembershipRole(first!.user.id, getActiveOrgId())).toBe('Owner');
  });
});
