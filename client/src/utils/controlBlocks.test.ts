import { describe, it, expect } from 'vitest';
import { stripAssistantControlBlocks } from './controlBlocks';

/**
 * Tests for the client-side control-block stripper.
 *
 * Regression coverage for the "skill block renders as visible code block"
 * bug (v1.13.0): agents sometimes emit <agenthub:skill> blocks either as
 * naked XML tags or wrapped in triple-backtick fences. Both variants must
 * be removed from the rendered chat transcript.
 */
describe('stripAssistantControlBlocks', () => {
  it('returns non-string input unchanged', () => {
    expect(stripAssistantControlBlocks(null)).toBeNull();
    expect(stripAssistantControlBlocks(undefined)).toBeUndefined();
    expect(stripAssistantControlBlocks('')).toBe('');
  });

  it('strips naked <agenthub:close-card> blocks', () => {
    const text = [
      'All done.',
      '',
      '<agenthub:close-card>',
      '{"reason":"already-done","note":"Preview saved."}',
      '</agenthub:close-card>',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toContain('<agenthub:close-card>');
    expect(result!).toContain('All done.');
  });

  it('strips a naked <agenthub:skill> block', () => {
    const text = [
      'Done with the analysis.',
      '',
      '<agenthub:skill>',
      '{"name": "kanban", "reason": "need board access"}',
      '</agenthub:skill>',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toContain('<agenthub:skill>');
    expect(result!).not.toContain('kanban');
    expect(result!).toContain('Done with the analysis.');
  });

  it('strips a <agenthub:skill> block wrapped in backtick fences', () => {
    const text = [
      'I need the wiki skill.',
      '',
      '```',
      '<agenthub:skill>{"name": "wiki-search", "reason": "check docs"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toContain('<agenthub:skill>');
    expect(result!).not.toContain('wiki-search');
    expect(result!).not.toContain('```');
    expect(result!).toContain('I need the wiki skill.');
  });

  it('strips a <agenthub:skill> block wrapped in tilde fences (markdown ~~~)', () => {
    const text = [
      'Loading docs skill.',
      '~~~',
      '<agenthub:skill>{"name":"wiki-search"}</agenthub:skill>',
      '~~~',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toContain('<agenthub:skill>');
    expect(result!).not.toContain('~~~');
    expect(result!).toContain('Loading docs skill.');
  });

  it('strips fenced skill block with surrounding prose before the fence', () => {
    const text = [
      'Wrapping up this turn.',
      '',
      '```json',
      '<agenthub:skill>{"name":"kanban","reason":"next turn"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).toContain('Wrapping up this turn.');
    expect(result!).not.toContain('<agenthub:skill>');
    expect(result!).not.toContain('```');
  });

  it('strips a naked <agenthub:react> block', () => {
    const text = [
      'Searching wiki.',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"deployment"}]}</agenthub:react>',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toContain('<agenthub:react>');
    expect(result!).toContain('Searching wiki.');
  });

  it('strips all supported control block types', () => {
    const text = [
      'Content.',
      '<agenthub:react>{"actions":[]}</agenthub:react>',
      '<agenthub:wiki>{"query":"foo"}</agenthub:wiki>',
      '<agenthub:task-state>{"status":"ok"}</agenthub:task-state>',
      '<agenthub:triage>{"x":1}</agenthub:triage>',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    expect(result!).not.toMatch(/<agenthub:/);
    expect(result!).toContain('Content.');
  });

  it('preserves prose that does NOT contain control blocks', () => {
    const text = 'This is normal prose with no control blocks.';
    expect(stripAssistantControlBlocks(text)).toBe(text);
  });

  it('collapses excess blank lines left by stripping', () => {
    const text = [
      'Line one.',
      '',
      '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
      '',
      '',
      'Line two.',
    ].join('\n');
    const result = stripAssistantControlBlocks(text);
    // Should not have more than one blank line between paragraphs
    expect(result!).not.toMatch(/\n{3,}/);
    expect(result!).toContain('Line one.');
    expect(result!).toContain('Line two.');
  });
});
