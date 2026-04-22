import { describe, it, expect } from 'vitest';
import {
  formatOuterOrchestrationPromptAppend,
  normalizeOrchestrationMetaInput,
  parseOrchestrationMetaJson,
  parseOrchestrationPhase,
} from './orchestration.js';
import { MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES } from './agenthub-control-limits.js';
import { buildEnrichedPrompt } from './chat.js';
import type { Project } from './types.js';

describe('parseOrchestrationPhase', () => {
  it('accepts canonical slugs case-insensitively', () => {
    expect(parseOrchestrationPhase('VERIFYING')).toBe('verifying');
    expect(parseOrchestrationPhase('  Acting  ')).toBe('acting');
  });

  it('returns null for nullish or blank', () => {
    expect(parseOrchestrationPhase(null)).toBeNull();
    expect(parseOrchestrationPhase(undefined)).toBeNull();
    expect(parseOrchestrationPhase('')).toBeNull();
    expect(parseOrchestrationPhase('   ')).toBeNull();
  });

  it('returns invalid for unknown or wrong types', () => {
    expect(parseOrchestrationPhase('plan')).toBe('invalid');
    expect(parseOrchestrationPhase(1)).toBe('invalid');
  });
});

describe('normalizeOrchestrationMetaInput', () => {
  it('serializes objects and clears on null', () => {
    expect(normalizeOrchestrationMetaInput(null)).toEqual({ ok: true, serialized: null });
    const ok = normalizeOrchestrationMetaInput({ pr: 601 });
    expect(ok.ok && ok.serialized).toContain('"pr":601');
  });

  it('rejects arrays and non-objects', () => {
    expect(normalizeOrchestrationMetaInput([])).toEqual({ ok: false, error: 'invalid' });
    expect(normalizeOrchestrationMetaInput('x')).toEqual({ ok: false, error: 'invalid' });
  });

  it('rejects serialized JSON over the control-block byte cap', () => {
    let pad = '';
    while (
      Buffer.byteLength(JSON.stringify({ b: pad }), 'utf8') <= MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES
    ) {
      pad += 'x';
    }
    expect(normalizeOrchestrationMetaInput({ b: pad })).toEqual({
      ok: false,
      error: 'oversize',
    });
  });
});

describe('parseOrchestrationMetaJson', () => {
  it('returns null for invalid JSON', () => {
    expect(parseOrchestrationMetaJson('{')).toBeNull();
  });
});

describe('formatOuterOrchestrationPromptAppend', () => {
  it('returns null when nothing set', () => {
    expect(formatOuterOrchestrationPromptAppend(null, null)).toBeNull();
    expect(formatOuterOrchestrationPromptAppend('', '{}')).toBeNull();
  });

  it('includes verifying guidance', () => {
    const s = formatOuterOrchestrationPromptAppend('verifying', null);
    expect(s).toContain('verifying');
    expect(s).toContain('validation');
  });
});

describe('buildEnrichedPrompt + outer orchestration', () => {
  const project = {
    id: 'p1',
    name: 'P',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as unknown as Project;

  const agent = {
    id: 'a1',
    name: 'Agent',
    engine: 'claude-code',
    model: 'claude-opus-4-6',
    workspace: '/tmp',
  };

  it('appends outer orchestration when phase is set', () => {
    const prompt = buildEnrichedPrompt(project, agent, {
      isFirstMessage: false,
      orchestrationPhase: 'acting',
      orchestrationMetaJson: null,
    });
    expect(prompt).toContain('Outer orchestration');
    expect(prompt).toContain('**acting**');
  });
});
