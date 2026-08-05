import { describe, it, expect } from 'vitest';
import {
  AUTH_CODE_GITHUB_NOT_CONNECTED,
  AUTH_CODE_INVALID_SESSION,
  AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP,
  GITHUB_NOT_CONNECTED_STATUS,
  isDeadSessionResponse,
} from './authErrorCodes.js';

describe('isDeadSessionResponse', () => {
  it('treats a tagged 401 as a dead session', () => {
    expect(isDeadSessionResponse(401, AUTH_CODE_INVALID_SESSION)).toBe(true);
  });

  it('treats a tagged 403 membership failure as a dead session', () => {
    expect(isDeadSessionResponse(403, AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP)).toBe(true);
  });

  // The logout-loop regression: an unconnected GitHub account answered 401,
  // and the blanket status check threw away a valid JWT.
  it('does not treat an untagged 401 as a dead session', () => {
    expect(isDeadSessionResponse(401, undefined)).toBe(false);
    expect(isDeadSessionResponse(401, null)).toBe(false);
    expect(isDeadSessionResponse(401, AUTH_CODE_GITHUB_NOT_CONNECTED)).toBe(false);
  });

  it('does not treat an ordinary permission 403 as a dead session', () => {
    expect(isDeadSessionResponse(403, undefined)).toBe(false);
    expect(isDeadSessionResponse(403, 'forbidden')).toBe(false);
  });

  it('never treats the github-not-connected status as a dead session', () => {
    expect(isDeadSessionResponse(GITHUB_NOT_CONNECTED_STATUS, AUTH_CODE_GITHUB_NOT_CONNECTED)).toBe(
      false,
    );
  });

  it('ignores codes on statuses that are not 401 or 403', () => {
    expect(isDeadSessionResponse(500, AUTH_CODE_INVALID_SESSION)).toBe(false);
    expect(isDeadSessionResponse(200, AUTH_CODE_INVALID_SESSION)).toBe(false);
  });
});
