import {
  parseHandoffBlock,
  handoffHasTrailingContent,
  buildHandoffContextBlock,
  resolveTargetAgentId,
  deriveHandoffSessionTitle,
  HANDOFF_TRANSCRIPT_MAX_TURNS,
} from './handoff.js';
import type { Agent } from './types.js';

describe('parseHandoffBlock', () => {
  it('extracts a valid handoff block with toAgent and note', () => {
    const text = `Sure, I've mapped the fix. Handing off.

<handoff>
{"toAgent": "hub-backend", "note": "Implement the P0 fix per card b952."}
</handoff>`;
    const result = parseHandoffBlock(text);
    expect(result).not.toBeNull();
    expect(result!.toAgent).toBe('hub-backend');
    expect(result!.note).toBe('Implement the P0 fix per card b952.');
  });

  it('returns null when no block is present', () => {
    expect(parseHandoffBlock('just some text, no handoff here')).toBeNull();
  });

  it('returns null when the block body is not valid JSON', () => {
    const text = `<handoff>toAgent: hub-backend\nnote: whatever</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('returns null when toAgent is missing', () => {
    const text = `<handoff>\n{"note": "hello"}\n</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('returns null when note is missing', () => {
    const text = `<handoff>\n{"toAgent": "hub-backend"}\n</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('returns null when toAgent is an empty string', () => {
    const text = `<handoff>\n{"toAgent": "   ", "note": "x"}\n</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('returns null when note is an empty string', () => {
    const text = `<handoff>\n{"toAgent": "hub-backend", "note": "   "}\n</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('returns null when the payload is an array (delegate-style)', () => {
    const text = `<handoff>\n[{"toAgent": "hub-backend", "note": "hi"}]\n</handoff>`;
    expect(parseHandoffBlock(text)).toBeNull();
  });

  it('trims whitespace from toAgent and note', () => {
    const text = `<handoff>\n{"toAgent": "  hub-backend  ", "note": "  Do the thing.  "}\n</handoff>`;
    const result = parseHandoffBlock(text);
    expect(result).toEqual({ toAgent: 'hub-backend', note: 'Do the thing.' });
  });

  it('preserves multi-line notes', () => {
    const note = 'Line one.\nLine two.\nLine three.';
    const text = `<handoff>\n${JSON.stringify({ toAgent: 'hub-backend', note })}\n</handoff>`;
    const result = parseHandoffBlock(text);
    expect(result!.note).toBe(note);
  });

  it('takes only the first block when multiple are present', () => {
    const text = `<handoff>
{"toAgent": "first", "note": "a"}
</handoff>
<handoff>
{"toAgent": "second", "note": "b"}
</handoff>`;
    const result = parseHandoffBlock(text);
    expect(result!.toAgent).toBe('first');
  });

  it('ignores unknown extra fields without failing', () => {
    const text = `<handoff>
{"toAgent": "hub-backend", "note": "go", "extra": {"thing": 1}, "priority": "high"}
</handoff>`;
    const result = parseHandoffBlock(text);
    expect(result).toEqual({ toAgent: 'hub-backend', note: 'go' });
  });
});

describe('handoffHasTrailingContent', () => {
  it('returns false when no block is present', () => {
    expect(handoffHasTrailingContent('no block here')).toBe(false);
  });

  it('returns false when block is last with only whitespace after', () => {
    const text = `<handoff>\n{"toAgent": "x", "note": "y"}\n</handoff>\n\n   `;
    expect(handoffHasTrailingContent(text)).toBe(false);
  });

  it('returns true when meaningful text follows the closing tag', () => {
    const text = `<handoff>\n{"toAgent": "x", "note": "y"}\n</handoff>\n\nAlso, by the way...`;
    expect(handoffHasTrailingContent(text)).toBe(true);
  });
});

describe('buildHandoffContextBlock', () => {
  const baseMessages = [
    { role: 'user', content: 'Hi, please plan the webhook fix.' },
    { role: 'assistant', content: "I'll look at server/webhooks/github.ts." },
    { role: 'user', content: 'Great, what did you find?' },
    { role: 'assistant', content: 'Line 234 needs fast-ack before the SQLite write.' },
  ];

  it('renders the fromAgentName header, note, and transcript', () => {
    const out = buildHandoffContextBlock({
      fromAgentName: 'Agent Hub Lead',
      note: 'Implement the fix.',
      messages: baseMessages,
    });
    expect(out).toContain('## HANDOFF FROM Agent Hub Lead');
    expect(out).toContain('> Implement the fix.');
    expect(out).toContain('[user]: Hi, please plan the webhook fix.');
    expect(out).toContain('[assistant]: Line 234 needs fast-ack before the SQLite write.');
    expect(out).toContain('Previous session transcript (4 turns)');
  });

  it('quotes multi-line notes line-by-line', () => {
    const out = buildHandoffContextBlock({
      fromAgentName: 'Lead',
      note: 'Line A.\nLine B.\nLine C.',
      messages: baseMessages,
    });
    expect(out).toContain('> Line A.');
    expect(out).toContain('> Line B.');
    expect(out).toContain('> Line C.');
  });

  it('truncates transcript to the last maxTurns messages and labels truncation', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }));
    const out = buildHandoffContextBlock({
      fromAgentName: 'Lead',
      note: 'See below.',
      messages: many,
      maxTurns: 10,
    });
    expect(out).toContain('last 10 of 120 turns');
    // First kept message is msg 110 (indices 110..119 are the last 10).
    expect(out).toContain('msg 110');
    expect(out).toContain('msg 119');
    expect(out).not.toContain('msg 0');
    expect(out).not.toContain('msg 109');
  });

  it('uses HANDOFF_TRANSCRIPT_MAX_TURNS when maxTurns is not supplied', () => {
    // Create one more than the default so we can detect the default kicking in.
    const many = Array.from({ length: HANDOFF_TRANSCRIPT_MAX_TURNS + 5 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const out = buildHandoffContextBlock({
      fromAgentName: 'Lead',
      note: 'x',
      messages: many,
    });
    expect(out).toContain(
      `last ${HANDOFF_TRANSCRIPT_MAX_TURNS} of ${HANDOFF_TRANSCRIPT_MAX_TURNS + 5} turns`,
    );
  });

  it('omits the truncation marker when the transcript fits under the cap', () => {
    const out = buildHandoffContextBlock({
      fromAgentName: 'Lead',
      note: 'x',
      messages: baseMessages,
    });
    expect(out).not.toContain('last ');
  });

  it('renders a placeholder when the source transcript is empty', () => {
    const out = buildHandoffContextBlock({
      fromAgentName: 'Lead',
      note: 'Starting fresh.',
      messages: [],
    });
    expect(out).toContain('_(no prior messages)_');
  });
});

describe('resolveTargetAgentId', () => {
  const agents: Agent[] = [
    { id: 'agent-hub', name: 'Hub Lead Dev' } as Agent,
    { id: 'hub-frontend', name: 'Hub Frontend' } as Agent,
    { id: 'hub-backend', name: 'Hub Backend' } as Agent,
    { id: 'hub-electron', name: 'Hub Electron' } as Agent,
    { id: 'hub-mobile', name: 'Hub Mobile' } as Agent,
  ];

  it('returns the exact id when it matches', () => {
    expect(resolveTargetAgentId('hub-backend', agents)).toBe('hub-backend');
  });

  it('resolves "agent-hub-backend" (AGENTS.md style) to "hub-backend"', () => {
    // The common failure mode: AGENTS.md prose uses "Agent Hub Backend
    // (agent-hub-backend)" but the canonical id is "hub-backend". Without
    // this fuzzy path, handoffs silently fail.
    expect(resolveTargetAgentId('agent-hub-backend', agents)).toBe('hub-backend');
  });

  it('resolves "agent-hub-frontend" to "hub-frontend"', () => {
    expect(resolveTargetAgentId('agent-hub-frontend', agents)).toBe('hub-frontend');
  });

  it('resolves by display name (case-insensitive)', () => {
    expect(resolveTargetAgentId('Hub Backend', agents)).toBe('hub-backend');
    expect(resolveTargetAgentId('hub backend', agents)).toBe('hub-backend');
  });

  it('resolves a bare suffix when it is unambiguous', () => {
    expect(resolveTargetAgentId('backend', agents)).toBe('hub-backend');
  });

  it('returns null for completely unknown ids', () => {
    expect(resolveTargetAgentId('ghost-agent', agents)).toBeNull();
  });

  it('returns null for empty / invalid input', () => {
    expect(resolveTargetAgentId('', agents)).toBeNull();
    expect(resolveTargetAgentId('   ', agents)).toBeNull();
  });

  it('returns null when no agents are provided', () => {
    expect(resolveTargetAgentId('hub-backend', [])).toBeNull();
  });

  it('refuses an ambiguous suffix match', () => {
    const ambiguous: Agent[] = [
      { id: 'alpha-backend', name: 'Alpha Backend' } as Agent,
      { id: 'beta-backend', name: 'Beta Backend' } as Agent,
    ];
    // "backend" matches both suffixes; must not guess.
    expect(resolveTargetAgentId('backend', ambiguous)).toBeNull();
  });

  it('prefers exact id over a suffix match on the same input', () => {
    const mix: Agent[] = [
      { id: 'backend', name: 'Plain Backend' } as Agent,
      { id: 'hub-backend', name: 'Hub Backend' } as Agent,
    ];
    expect(resolveTargetAgentId('backend', mix)).toBe('backend');
  });
});

describe('deriveHandoffSessionTitle', () => {
  it('uses only the first line of a multi-line note', () => {
    const note =
      'Implement SSM deploy file-exec fix\n\nBackground: the current wrapper drops PAM exit codes.\nSee wiki page for details.';
    expect(deriveHandoffSessionTitle(note, 'Hub Frontend')).toBe(
      'Implement SSM deploy file-exec fix',
    );
  });

  it('skips leading blank lines and picks the first non-empty line', () => {
    const note = '\n   \nFix PR titles for handoff-sourced sessions\nMore detail below.';
    expect(deriveHandoffSessionTitle(note, 'Hub Frontend')).toBe(
      'Fix PR titles for handoff-sourced sessions',
    );
  });

  it('truncates a long single-line note with an ellipsis on a word boundary', () => {
    const note =
      'Fix the auto-git PR title generation so that handoff-sourced sessions without a linked kanban card produce a readable title derived from the note instead of a timestamp string';
    const title = deriveHandoffSessionTitle(note, 'Hub Frontend');
    // buildPrTitle caps at 70 chars including the ellipsis.
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('Fix the auto-git PR title')).toBe(true);
    // Must not contain a timestamp.
    expect(title).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('strips trailing punctuation from the first line', () => {
    expect(deriveHandoffSessionTitle('Fix login crash.', 'Hub Backend')).toBe('Fix login crash');
    expect(deriveHandoffSessionTitle('Did it!\nNext up: cleanup.', 'Hub Backend')).toBe('Did it');
  });

  it('falls back to "Handoff from <agent>" when the note is empty', () => {
    expect(deriveHandoffSessionTitle('', 'Hub Frontend')).toBe('Handoff from Hub Frontend');
    expect(deriveHandoffSessionTitle('   \n\t  ', 'Hub Frontend')).toBe(
      'Handoff from Hub Frontend',
    );
  });

  it('fallback uses a generic label when the source agent name is also empty', () => {
    expect(deriveHandoffSessionTitle('', '')).toBe('Handoff from agent');
    expect(deriveHandoffSessionTitle('', '   ')).toBe('Handoff from agent');
  });

  it('never emits a locale timestamp (regression guard for PR #363)', () => {
    // The original bug produced titles like
    //   "Handoff from Hub Backend — 4/17/2026, 10:31:45 PM"
    // Make sure neither the happy path nor the fallback ever reintroduces
    // date/time formatting in the output.
    const happy = deriveHandoffSessionTitle('Ship the SSM privilege-drop fix', 'Hub Backend');
    const fallback = deriveHandoffSessionTitle('', 'Hub Backend');
    for (const title of [happy, fallback]) {
      expect(title).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/); // date
      expect(title).not.toMatch(/\d{1,2}:\d{2}/); // time
      expect(title).not.toMatch(/ — /); // the em-dash separator the old format used
    }
  });
});
