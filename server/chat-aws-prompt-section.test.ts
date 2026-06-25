/**
 * Regression for the "AWS asks me to log in again even though I'm already
 * logged in" bug (card 6f7014c9).
 *
 * A spawned agent probes /aws-sso/status with the break-glass x-api-key, which
 * resolves to the shared host HOME. A user who logged in via the web AWS
 * settings module authenticated under their own per-user HOME, whose token
 * cache the probe never reads (cross-user enumeration is a security no-go). So
 * the probe reports loggedIn:false even though the user is signed in. The old
 * prompt told the agent to POST /aws-sso/login and surface a device URL in that
 * case — the exact redundant "log in again" flow. The section must instead
 * point the user at the AWS settings module and never self-initiate a login.
 */
import { describe, it, expect } from 'vitest';
import { buildProjectAwsPromptSection } from './chat.js';

describe('buildProjectAwsPromptSection', () => {
  it('returns empty string when the project has no configured profiles', () => {
    expect(buildProjectAwsPromptSection('agent-hub', [])).toBe('');
  });

  it('lists the configured profile names', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub', 'staging']);
    expect(out).toContain('## Project AWS');
    expect(out).toContain('agenthub, staging');
  });

  it('does NOT instruct the agent to self-initiate an SSO login on a false probe', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    // No device-code login flow driven by the agent.
    expect(out).not.toContain('/aws-sso/login');
    expect(out).not.toMatch(/loginUrl/i);
    expect(out).not.toMatch(/aws sso login/i);
    expect(out).not.toMatch(/device URL/i);
  });

  it('points the user to the AWS settings module instead', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    expect(out).toMatch(/do not start an SSO login yourself/i);
    expect(out).toMatch(/AWS.*settings module|settings module/i);
    expect(out).toMatch(/Check login/i);
  });

  it('explains the false-negative cause (token cached under an unreadable HOME)', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    expect(out).toMatch(/HOME/);
    expect(out).toMatch(/can't see|cannot see|can't read|cannot read/i);
  });

  it('keeps the status-check endpoint and read wrappers', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    expect(out).toContain('/api/projects/agent-hub/aws-sso/status');
    expect(out).toContain('scripts/aws-whoami.sh');
    expect(out).toContain('scripts/aws-q.sh');
  });
});
