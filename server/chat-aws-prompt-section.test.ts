/**
 * Regression for the "AWS asks me to log in again even though I'm already
 * logged in" bug (card 6f7014c9).
 *
 * The prompt must send agents through the session-aware Hub API wrapper. That
 * wrapper attaches X-Agent-Hub-Session-Id, allowing /aws-sso/status to resolve
 * the session owner's per-user HOME and trust the same login the web AWS
 * settings module validated. The old prompt used a raw Authorization probe and
 * told agents the Settings login was usually unreadable, which caused the
 * redundant "tell the agent I'm logged in" loop.
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

  it('explains that Hub status checks the Settings login HOME', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    expect(out).toMatch(/per-user HOME/);
    expect(out).toMatch(/AWS.*settings module/i);
    expect(out).not.toMatch(/shared host HOME/i);
    expect(out).not.toMatch(/can't see|cannot see|can't read|cannot read/i);
  });

  // Step 3 of the prompt ("point the user at the AWS settings module") is a
  // dead end for a heartbeat / cron / autonomous spawn: there is no human to
  // click SSO login. The monitoring designation is the profile that still
  // authenticates in that situation, so the prompt has to name it.
  it('names the monitoring profile as the unattended fallback when one is designated', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub', 'monitoring'], 'monitoring');
    expect(out).toMatch(/--profile monitoring/);
    expect(out).toMatch(/cron, autonomous dispatch/i);
    expect(out).toMatch(/without an interactive login/i);
  });

  // It is a fallback for unattended runs, not an override of the user's intent.
  it('tells the agent not to substitute it for a profile the user named', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub'], 'monitoring');
    expect(out).toMatch(/Do not use it to stand in for a profile the user named/i);
  });

  it('omits the unattended guidance entirely when no monitoring profile is designated', () => {
    for (const designation of [undefined, null, '']) {
      const out = buildProjectAwsPromptSection('agent-hub', ['agenthub'], designation);
      expect(out).toContain('## Project AWS');
      expect(out).not.toMatch(/Unattended runs/i);
      expect(out).not.toMatch(/monitoring profile/i);
    }
  });

  // The designation must never smuggle an SSO login instruction back in.
  it('keeps the no-self-initiated-login rule with a designation present', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub'], 'monitoring');
    expect(out).not.toMatch(/aws sso login/i);
    expect(out).toMatch(/do not start an SSO login yourself/i);
  });

  it('uses the session-aware wrapper for the status-check endpoint and read wrappers', () => {
    const out = buildProjectAwsPromptSection('agent-hub', ['agenthub']);
    expect(out).toContain('ah-api.sh GET');
    expect(out).toContain('/api/projects/agent-hub/aws-sso/status');
    expect(out).not.toMatch(/Authorization:\s*Bearer/i);
    expect(out).toContain('aws-whoami.sh');
    expect(out).toContain('aws-q.sh');
  });
});
