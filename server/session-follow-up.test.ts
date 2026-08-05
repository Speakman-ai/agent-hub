import { describe, it, expect } from 'vitest';
import {
  buildFollowUpSeedMessage,
  buildFollowUpSessionName,
  findLatestFinalizeSummary,
} from './session-follow-up.js';

function summaryMessage(content: string, followUps: string[], runId = 'run-1') {
  return {
    content,
    metadata: JSON.stringify({ kind: 'finalize_run_summary', runId, followUps }),
  };
}

describe('findLatestFinalizeSummary', () => {
  it('returns null when the session never finalized', () => {
    expect(findLatestFinalizeSummary([{ content: 'hi', metadata: null }])).toBeNull();
    expect(findLatestFinalizeSummary([])).toBeNull();
    expect(findLatestFinalizeSummary(undefined)).toBeNull();
  });

  it('ignores other finalize timeline kinds', () => {
    const messages = [
      { content: 'Ready to push', metadata: JSON.stringify({ kind: 'finalize_ready_to_push' }) },
      { content: 'Round 1', metadata: JSON.stringify({ kind: 'finalize_review_round' }) },
    ];
    expect(findLatestFinalizeSummary(messages)).toBeNull();
  });

  // A session can finalize more than once (a fix turn re-runs the pipeline).
  // Only the last briefing describes the code that actually shipped, so an
  // earlier run's follow-up steps must not leak into the seed.
  it('takes the most recent summary when a session finalized twice', () => {
    const messages = [
      summaryMessage('## Finalize summary\nfirst', ['Run the old migration'], 'run-1'),
      { content: 'chatter', metadata: null },
      summaryMessage('## Finalize summary\nsecond', ['Run the new migration'], 'run-2'),
    ];
    const found = findLatestFinalizeSummary(messages);
    expect(found?.followUps).toEqual(['Run the new migration']);
    expect(found?.content).toContain('second');
  });

  it('reads server-shaped flat metadata and tolerates a missing follow-up list', () => {
    const found = findLatestFinalizeSummary([
      { content: 'body', metadata: JSON.stringify({ kind: 'finalize_run_summary' }) },
    ]);
    expect(found).toEqual({ content: 'body', followUps: [] });
  });

  it('drops non-string and blank follow-up entries', () => {
    const messages = [
      {
        content: 'body',
        metadata: JSON.stringify({
          kind: 'finalize_run_summary',
          followUps: ['Run migrate', '', '   ', 42, null],
        }),
      },
    ];
    expect(findLatestFinalizeSummary(messages)?.followUps).toEqual(['Run migrate']);
  });
});

describe('buildFollowUpSeedMessage', () => {
  const base = { sourceAgentName: 'Survey Tracker Dev', sourceSessionName: 'Add webhook retry' };

  it('leads with the operator prompt, then the context frame', () => {
    const out = buildFollowUpSeedMessage({ ...base, prompt: 'Also retry on 502.' });
    expect(out.indexOf('Also retry on 502.')).toBeLessThan(out.indexOf('--- Follow-up on'));
    expect(out).toContain('session with Survey Tracker Dev ("Add webhook retry")');
    expect(out.trimEnd().endsWith('--- End of follow-up context ---')).toBe(true);
  });

  // The follow-up session gets a fresh worktree cut from the base branch. An
  // agent that assumes it is still on the previous session's branch will try
  // to amend commits that are not there.
  it('always warns that the previous branch and worktree are gone', () => {
    const out = buildFollowUpSeedMessage(base);
    expect(out).toContain('NEW session on a fresh branch');
    expect(out).toContain('Do not try to amend or continue those commits');
  });

  it('lists the follow-up steps and quotes the finalize summary', () => {
    const out = buildFollowUpSeedMessage({
      ...base,
      summary: {
        content: '## Finalize summary\nAdds retry.',
        followUps: ['Run `npm run migrate` on prod', 'Set WEBHOOK_RETRY_MAX'],
      },
      prUrl: 'https://example.com/pr/12',
    });
    expect(out).toContain('Follow-up steps flagged at the end of that session:');
    expect(out).toContain('- Run `npm run migrate` on prod');
    expect(out).toContain('- Set WEBHOOK_RETRY_MAX');
    expect(out).toContain('Pull request from that session: https://example.com/pr/12');
    expect(out).toContain('## Finalize summary');
  });

  it('falls back to the transcript when the session never finalized', () => {
    const out = buildFollowUpSeedMessage({
      ...base,
      transcript: '[User]:\ndeploy it\n\n[Assistant]:\ndone',
    });
    expect(out).toContain('Recent conversation from that session:');
    expect(out).toContain('deploy it');
    expect(out).not.toContain('Finalize summary from that session:');
  });

  // The summary is the higher-signal context; including both would just push
  // the follow-up steps further from the top of a long message.
  it('prefers the summary over the transcript when both are available', () => {
    const out = buildFollowUpSeedMessage({
      ...base,
      summary: { content: '## Finalize summary\nAdds retry.', followUps: [] },
      transcript: 'SHOULD NOT APPEAR',
    });
    expect(out).toContain('Finalize summary from that session:');
    expect(out).not.toContain('SHOULD NOT APPEAR');
  });

  it('omits the pr line and the steps header when there is nothing to show', () => {
    const out = buildFollowUpSeedMessage({ ...base, summary: { content: 'body', followUps: [] } });
    expect(out).not.toContain('Pull request from that session');
    expect(out).not.toContain('Follow-up steps flagged');
  });

  it('drops the session-name clause when the source session is unnamed', () => {
    const out = buildFollowUpSeedMessage({ sourceAgentName: 'Dev', sourceSessionName: null });
    expect(out).toContain('--- Follow-up on session with Dev ---');
  });
});

describe('buildFollowUpSessionName', () => {
  it('prefixes the source name', () => {
    expect(buildFollowUpSessionName('Add webhook retry')).toBe('[Follow-up] Add webhook retry');
  });

  it('falls back for a blank name and caps at 100 chars', () => {
    expect(buildFollowUpSessionName('')).toBe('[Follow-up] Session');
    expect(buildFollowUpSessionName(null)).toBe('[Follow-up] Session');
    expect(buildFollowUpSessionName('x'.repeat(200))).toHaveLength(100);
  });
});
