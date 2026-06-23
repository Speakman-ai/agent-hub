import { describe, it, expect } from 'vitest';
import { extractAskBlocks, parseAskPayload, parseAskEnvelope } from './extractAskBlocks.js';

describe('parseAskPayload — wizard shape', () => {
  it('accepts label/value options and skips empty multi-select rows', () => {
    const raw = JSON.stringify({
      title: 'Confirm preview',
      questions: [
        {
          id: 'startScript',
          label: 'Start script',
          multiSelect: false,
          options: [{ value: 'npm run dev', label: 'npm run dev (vite)', default: true }],
        },
        {
          id: 'envKeys',
          label: 'Env vars',
          multiSelect: true,
          options: [],
        },
        {
          id: 'healthPath',
          label: 'Health check path',
          multiSelect: false,
          options: [
            { value: '/', label: '/ (root)', default: true },
            { value: '/healthz', label: '/healthz' },
          ],
        },
      ],
    });
    const questions = parseAskPayload(raw);
    expect(questions).not.toBeNull();
    expect(questions!.length).toBe(2);
    expect(questions!.map((q) => q.question)).toEqual(['Start script', 'Health check path']);
  });
});

describe('parseAskPayload — prompt/type shape', () => {
  it('accepts questions with prompt and value/label options (screenshot schema)', () => {
    const raw = JSON.stringify({
      title: 'Create docker-compose.yml?',
      questions: [
        {
          id: 'approve_bootstrap',
          prompt: 'May I create `docker-compose.yml` at the project root?',
          type: 'select',
          options: [
            { value: 'approve', label: 'Yes – create the file' },
            { value: 'skip', label: 'Skip – I will add it myself' },
          ],
          default: 'approve',
        },
      ],
    });
    const questions = parseAskPayload(raw);
    expect(questions).toHaveLength(1);
    expect(questions![0].question).toContain('docker-compose.yml');
    expect(questions![0].header).toBe('approve_boot');
    expect(questions![0].options.map((o) => o.label)).toEqual([
      'Yes – create the file',
      'Skip – I will add it myself',
    ]);
  });
});

describe('parseAskPayload — flat envelope', () => {
  it('accepts single question with askId at top level (preview bootstrap)', () => {
    const raw = JSON.stringify({
      askId: 'preview-bootstrap-approval',
      header: 'Write docker-compose.yml?',
      question: 'May I create docker-compose.yml at the project root?',
      multiSelect: false,
      options: [
        {
          label: 'Yes – write docker-compose.yml',
          description: 'Creates the file and continues setup',
        },
        { label: 'No – let me edit it first', description: 'Stop so I can edit manually' },
      ],
    });
    const envelope = parseAskEnvelope(raw);
    expect(envelope).not.toBeNull();
    expect(envelope!.askId).toBe('preview-bootstrap-approval');
    expect(envelope!.questions).toHaveLength(1);
  });
});

describe('extractAskBlocks — flat fenced envelope', () => {
  it('extracts askId + flat question object from fenced block', () => {
    const body = JSON.stringify({
      askId: 'preview-bootstrap-approval',
      header: 'Write docker-compose.yml?',
      question: 'May I create docker-compose.yml?',
      multiSelect: false,
      options: [
        { label: 'Yes', description: 'Create file' },
        { label: 'No', description: 'Skip' },
      ],
    });
    const { strippedText, asks } = extractAskBlocks('```agenthub:ask\n' + body + '\n```');
    expect(asks).toHaveLength(1);
    expect(asks[0].askId).toBe('preview-bootstrap-approval');
    expect(strippedText).not.toContain('preview-bootstrap');
  });
});

describe('extractAskBlocks — inline', () => {
  it('parses agenthub:ask {json}</agenthub:ask>', () => {
    const { asks } = extractAskBlocks(
      'agenthub:ask {"questions":[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]}</agenthub:ask>',
    );
    expect(asks).toHaveLength(1);
  });
});
