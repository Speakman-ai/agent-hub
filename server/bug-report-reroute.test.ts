import { describe, it, expect } from 'vitest';
import {
  isBugReportPayload,
  extractBugReportTitle,
  resolveBugReportReroute,
} from './bug-report-reroute.js';
import type { Agent, Project } from './types.js';

// ─── Fixtures ──────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'hub-lead',
    name: 'Hub Lead',
    engine: 'claude-code',
    role: 'lead',
    ...overrides,
  } as Agent;
}

function makeProject(agents: Agent[]): Project {
  return {
    id: 'agent-hub',
    name: 'Agent Hub',
    color: '#3B82F6',
    cwd: '/tmp/agent-hub',
    agents,
  } as unknown as Project;
}

const BUG_REPORT_BODY = `## Bug Report

**Title:** Design not accessible for export error
**Severity:** medium

### Description
Any way to bring costs down?

### Source Metadata
- **URL:** https://hub.example.com/project/agent-hub
- **Client Type:** web
`;

// ─── isBugReportPayload ────────────────────────────────────────────

describe('isBugReportPayload', () => {
  it('detects the canonical header at the top of a payload', () => {
    expect(isBugReportPayload(BUG_REPORT_BODY)).toBe(true);
  });

  it('tolerates leading whitespace before the header', () => {
    expect(isBugReportPayload('\n\n  ## Bug Report\n\n**Title:** x')).toBe(true);
  });

  it('returns false for normal chat messages', () => {
    expect(isBugReportPayload('hey can you take a look at PR #123')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isBugReportPayload('')).toBe(false);
  });

  it('ignores non-string input without throwing', () => {
    // @ts-expect-error — intentional misuse to validate runtime guard
    expect(isBugReportPayload(null)).toBe(false);
  });

  it('does not match a "## Bug Report" header buried deep in a long body', () => {
    const prefix = 'x'.repeat(800);
    const buried = `${prefix}\n## Bug Report\n**Title:** Ignored`;
    expect(isBugReportPayload(buried)).toBe(false);
  });

  it('does not match a "## Bug Report" header buried under another markdown header', () => {
    // Regression for card e1e519d9: the kanban assign endpoint builds a
    // context envelope of the shape "# Task: …\n## Description\n<card.desc>",
    // and a card description that came from the bug-report intake will
    // itself start with "## Bug Report". The detector must see this as the
    // **task envelope**, not as a fresh bug report — otherwise every assign
    // of such a card bounces back to intake.
    const envelope =
      '# Task: Move features & orchestration timeline to sidebar\n' +
      '\n' +
      '## Description\n' +
      '## Bug Report\n' +
      '**Severity:** medium\n' +
      '**Source:** Electron 1.11.0\n';
    expect(isBugReportPayload(envelope)).toBe(false);
  });

  it('does not match a "## Bug Report" header that follows any non-whitespace prefix', () => {
    // Stronger than the buried-deep case: any leading non-whitespace
    // character (a markdown header, a stray word, a bullet, etc.) before
    // the "## Bug Report" line means the body is not a fresh bug report.
    expect(isBugReportPayload('hi\n## Bug Report\n**Title:** x')).toBe(false);
    expect(isBugReportPayload('# Foo\n## Bug Report\n**Title:** x')).toBe(false);
    expect(isBugReportPayload('- item\n## Bug Report\n**Title:** x')).toBe(false);
  });

  it('matches only the exact "## Bug Report" header, not close variants', () => {
    // The trailing \b in the regex requires a word→non-word transition, so
    // "## Bug Reports" (plural) does NOT match and neither does "## Bug".
    expect(isBugReportPayload('## Bug Reports\n**Title:** x')).toBe(false);
    expect(isBugReportPayload('## Bug\n**Title:** x')).toBe(false);
    // Sanity check: a trailing punctuation/space is a word boundary, so these
    // DO match.
    expect(isBugReportPayload('## Bug Report:\n**Title:** x')).toBe(true);
    expect(isBugReportPayload('## Bug Report \n**Title:** x')).toBe(true);
  });
});

// ─── extractBugReportTitle ─────────────────────────────────────────

describe('extractBugReportTitle', () => {
  it('pulls the Title field out of the canonical body', () => {
    expect(extractBugReportTitle(BUG_REPORT_BODY)).toBe('Design not accessible for export error');
  });

  it('returns null when no Title line is present', () => {
    expect(extractBugReportTitle('## Bug Report\n\n### Description\nno title line')).toBe(null);
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error — intentional misuse
    expect(extractBugReportTitle(undefined)).toBe(null);
  });
});

// ─── resolveBugReportReroute ───────────────────────────────────────

describe('resolveBugReportReroute', () => {
  const intakeAgent = makeAgent({ id: 'agent-hub-intake', role: 'intake' });
  const leadAgent = makeAgent({ id: 'hub-lead', role: 'lead' });
  const projectWithIntake = makeProject([leadAgent, intakeAgent]);

  it('reroutes a bug-report payload addressed to a non-intake agent', () => {
    const target = resolveBugReportReroute(projectWithIntake, leadAgent, BUG_REPORT_BODY);
    expect(target).not.toBeNull();
    expect(target!.id).toBe('agent-hub-intake');
  });

  it('does not reroute when the addressed agent IS the intake agent', () => {
    const target = resolveBugReportReroute(projectWithIntake, intakeAgent, BUG_REPORT_BODY);
    expect(target).toBeNull();
  });

  it('does not reroute normal chat content', () => {
    const target = resolveBugReportReroute(projectWithIntake, leadAgent, 'hi there');
    expect(target).toBeNull();
  });

  it('does not reroute when the project has no intake agent', () => {
    const projectNoIntake = makeProject([leadAgent]);
    const target = resolveBugReportReroute(projectNoIntake, leadAgent, BUG_REPORT_BODY);
    expect(target).toBeNull();
  });

  it('does not reroute queue replays', () => {
    const target = resolveBugReportReroute(projectWithIntake, leadAgent, BUG_REPORT_BODY, {
      fromQueue: true,
    });
    expect(target).toBeNull();
  });

  it('does not reroute messages already flagged as rerouted (prevents loops)', () => {
    const target = resolveBugReportReroute(projectWithIntake, leadAgent, BUG_REPORT_BODY, {
      alreadyRerouted: true,
    });
    expect(target).toBeNull();
  });

  it('does not reroute messages dispatched by the kanban assign endpoint', () => {
    // Belt-and-suspenders: even if a body containing the bug-report header
    // somehow reaches the head-anchored detector (e.g. a card description
    // that literally starts with "## Bug Report"), an explicit user-driven
    // assign must respect the chosen assignee.
    const target = resolveBugReportReroute(projectWithIntake, leadAgent, BUG_REPORT_BODY, {
      fromBoardAssign: true,
    });
    expect(target).toBeNull();
  });

  it('reroutes regardless of which non-intake role is addressed', () => {
    for (const role of ['lead', 'reviewer', 'docs', 'specialist', undefined]) {
      const agent = makeAgent({ id: `x-${role}`, role: role as string | undefined });
      const target = resolveBugReportReroute(
        makeProject([agent, intakeAgent]),
        agent,
        BUG_REPORT_BODY,
      );
      expect(target?.id).toBe('agent-hub-intake');
    }
  });
});
