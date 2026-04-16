import {
  parseHandoffBlock,
  handoffHasTrailingContent,
  buildHandoffContextBlock,
  HANDOFF_TRANSCRIPT_MAX_TURNS,
} from './handoff.js';

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
