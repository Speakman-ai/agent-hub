import { describe, it, expect } from 'vitest';
import { findUnansweredAskIds } from './awaitingInput.js';

const askEnvelope = (askId, questionText = 'Pick one') => `
\`\`\`agenthub:ask
{
  "askId": "${askId}",
  "question": "${questionText}",
  "header": "Pick",
  "options": [
    { "label": "A", "description": "" },
    { "label": "B", "description": "" }
  ]
}
\`\`\`
`;

const answerBlock = (askId) => `
\`\`\`agenthub:ask:answer
{ "askId": "${askId}", "answers": { "Pick one": "A" } }
\`\`\`
`;

describe('findUnansweredAskIds', () => {
  it('returns empty when there are no messages', () => {
    expect(findUnansweredAskIds([])).toEqual([]);
    expect(findUnansweredAskIds(null)).toEqual([]);
    expect(findUnansweredAskIds(undefined)).toEqual([]);
  });

  it('returns empty when the latest assistant message has no ask block', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello, world.' },
    ];
    expect(findUnansweredAskIds(messages)).toEqual([]);
  });

  it('reports an unanswered ask when no user answer block exists', () => {
    const messages = [
      { role: 'user', content: 'help me pick' },
      { role: 'assistant', content: 'Sure. ' + askEnvelope('ask-1') },
    ];
    expect(findUnansweredAskIds(messages)).toEqual(['ask-1']);
  });

  it('clears the ask once a user message contains a matching answer block', () => {
    const messages = [
      { role: 'user', content: 'help me pick' },
      { role: 'assistant', content: 'Sure. ' + askEnvelope('ask-1') },
      { role: 'user', content: answerBlock('ask-1') },
    ];
    expect(findUnansweredAskIds(messages)).toEqual([]);
  });

  it('only checks the LATEST assistant message — older asks are stale', () => {
    const messages = [
      { role: 'assistant', content: 'Stale prompt: ' + askEnvelope('ask-old') },
      { role: 'user', content: 'never mind, different question' },
      { role: 'assistant', content: 'New prompt: ' + askEnvelope('ask-new') },
    ];
    expect(findUnansweredAskIds(messages)).toEqual(['ask-new']);
  });

  it('returns all unanswered ids when an assistant message bundles multiple pickers', () => {
    const messages = [
      {
        role: 'assistant',
        content: askEnvelope('ask-a', 'Q A') + '\n\n' + askEnvelope('ask-b', 'Q B'),
      },
      { role: 'user', content: answerBlock('ask-a') },
    ];
    expect(findUnansweredAskIds(messages)).toEqual(['ask-b']);
  });

  it('ignores malformed answer blocks', () => {
    const messages = [
      { role: 'assistant', content: askEnvelope('ask-1') },
      { role: 'user', content: '```agenthub:ask:answer\n{not json\n```' },
    ];
    expect(findUnansweredAskIds(messages)).toEqual(['ask-1']);
  });

  it('handles the XML answer form too', () => {
    const xmlAnswer = '<agenthub:ask:answer>{"askId":"ask-1"}</agenthub:ask:answer>';
    const messages = [
      { role: 'assistant', content: askEnvelope('ask-1') },
      { role: 'user', content: xmlAnswer },
    ];
    expect(findUnansweredAskIds(messages)).toEqual([]);
  });
});
