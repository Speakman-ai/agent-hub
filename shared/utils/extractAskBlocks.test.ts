import { describe, it, expect } from 'vitest';
import {
  extractAskBlocks,
  parseAskPayload,
  parseAskEnvelope,
  scanFences,
} from './extractAskBlocks.js';

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

// Every shape below used to fall through the parser and render as a wall of
// raw JSON in chat ("ask isn't rendering"). They are the payloads models
// actually emit, so each one is a regression case.
describe('extractAskBlocks — shapes models actually emit', () => {
  const question = (opts: string) => `[{"question":"Q?","header":"H","options":${opts}}]`;
  const twoOptions = '[{"label":"A","description":"a"},{"label":"B","description":"b"}]';

  function expectRendered(text: string) {
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(strippedText).not.toContain('agenthub:ask');
    return asks[0];
  }

  it('accepts an info string that carries a language tag before the token', () => {
    expectRendered('```json agenthub:ask\n' + question(twoOptions) + '\n```');
  });

  it('accepts a tilde fence', () => {
    expectRendered('~~~agenthub:ask\n' + question(twoOptions) + '\n~~~');
  });

  it('does not end the block on a fence run inside a preview string', () => {
    const body =
      '[{"question":"Q?","header":"H","options":[' +
      JSON.stringify({ label: 'A', preview: '```js\nconst x = 1;\n```' }) +
      ',{"label":"B","description":"b"}]}]';
    const ask = expectRendered('```agenthub:ask\n' + body + '\n```');
    expect(ask.questions[0].options).toHaveLength(2);
    expect(ask.questions[0].options[0].preview).toContain('const x = 1;');
  });

  it('repairs trailing commas', () => {
    const ask = expectRendered(
      '```agenthub:ask\n[{"question":"Q?","options":[{"label":"A"},{"label":"B"},],}]\n```',
    );
    expect(ask.questions[0].options).toHaveLength(2);
  });

  // The repair only fires once the plain parse has failed, so a field value
  // that merely looks like a trailing comma rides along with a real one.
  it('leaves comma-plus-bracket sequences inside string values alone', () => {
    const ask = expectRendered(
      '```agenthub:ask\n' +
        '[{"question":"Q?","options":[' +
        '{"label":"A","preview":"x,}","description":"ends ,]"},' +
        '{"label":"B","preview":"y,]"},' +
        '],}]\n```',
    );
    expect(ask.questions[0].options).toHaveLength(2);
    expect(ask.questions[0].options[0].preview).toBe('x,}');
    expect(ask.questions[0].options[0].description).toBe('ends ,]');
    expect(ask.questions[0].options[1].preview).toBe('y,]');
  });

  it('keeps an escaped quote from ending string tracking mid-repair', () => {
    const optA = JSON.stringify({ label: 'A', preview: 'say "hi" ,} then \\ ,]' });
    const optB = JSON.stringify({ label: 'B' });
    const ask = expectRendered(
      '```agenthub:ask\n[{"question":"Q?","options":[' + optA + ',' + optB + ',]}]\n```',
    );
    expect(ask.questions[0].options).toHaveLength(2);
    expect(ask.questions[0].options[0].preview).toBe('say "hi" ,} then \\ ,]');
  });

  it('accepts bare-string options', () => {
    const ask = expectRendered('```agenthub:ask\n[{"question":"Q?","options":["A","B"]}]\n```');
    expect(ask.questions[0].options.map((o) => o.label)).toEqual(['A', 'B']);
  });

  it('accepts choices as an alias for options', () => {
    const ask = expectRendered(
      '```agenthub:ask\n[{"question":"Q?","choices":[{"label":"A"},{"label":"B"}]}]\n```',
    );
    expect(ask.questions[0].options).toHaveLength(2);
  });

  it('keeps a question with more than 4 options, clamping at 8', () => {
    const many = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ label: `opt-${i}` })));
    const ask = expectRendered('```agenthub:ask\n' + question(many) + '\n```');
    expect(ask.questions[0].options).toHaveLength(8);
    expect(ask.questions[0].options[0].label).toBe('opt-0');
  });

  it('drops duplicate option labels (selection state is label-addressed)', () => {
    const ask = expectRendered(
      '```agenthub:ask\n[{"question":"Q?","options":[{"label":"A"},{"label":"A"},{"label":"B"}]}]\n```',
    );
    expect(ask.questions[0].options.map((o) => o.label)).toEqual(['A', 'B']);
  });

  it('accepts a multi-select question with a single option', () => {
    const ask = expectRendered(
      '```agenthub:ask\n[{"question":"Q?","multiSelect":true,"options":[{"label":"A"}]}]\n```',
    );
    expect(ask.questions[0].multiSelect).toBe(true);
    expect(ask.questions[0].options).toHaveLength(1);
  });

  it('accepts multi_select / multiple spellings', () => {
    for (const key of ['multi_select', 'multiple']) {
      const ask = expectRendered(
        `\`\`\`agenthub:ask\n[{"question":"Q?","${key}":true,"options":${twoOptions}}]\n\`\`\``,
      );
      expect(ask.questions[0].multiSelect).toBe(true);
    }
  });

  it('ignores prose the model wrote inside the fence alongside the payload', () => {
    expectRendered('```agenthub:ask\nHere is the picker:\n' + question(twoOptions) + '\n```');
  });

  it('still refuses a fence whose body is not JSON at all', () => {
    const text = '```agenthub:ask\nnot json, just prose\n```';
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
    expect(strippedText).toBe(text);
  });

  it('never treats an agenthub:ask:answer fence as a picker', () => {
    const text = '```agenthub:ask:answer\n{"askId":"x","answers":{"Q?":"A"},"annotations":{}}\n```';
    const { asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
  });

  it('keeps an unterminated fence intact while it is still streaming', () => {
    const text = '```agenthub:ask\n' + question(twoOptions);
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
    expect(strippedText).toBe(text);
  });
});

describe('extractAskBlocks — CRLF line endings', () => {
  const payload = '[{"question":"Q?","header":"H","options":[{"label":"A"},{"label":"B"}]}]';

  // The scan splits on '\n', so every line keeps its CR. A closing fence read
  // as "``` plus junk" never closes the block, and the JSON renders raw.
  it.each([
    ['backtick', '```agenthub:ask\r\n' + payload + '\r\n```\r\n'],
    ['tilde', '~~~agenthub:ask\r\n' + payload + '\r\n~~~\r\n'],
    ['language-tagged', '```json agenthub:ask\r\n' + payload + '\r\n```\r\n'],
  ])('closes a %s fence written with CRLF', (_label, text) => {
    const { strippedText, asks } = extractAskBlocks('Pick one:\r\n\r\n' + text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options).toHaveLength(2);
    expect(strippedText).not.toContain('agenthub:ask');
    expect(strippedText).not.toContain('"question"');
  });

  it('still locks a CRLF doc example inside another fence', () => {
    const text = '```text\r\n```agenthub:ask\r\n' + payload + '\r\n```\r\n```\r\nDone.\r\n';
    const { asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
  });
});

describe('extractAskBlocks — info-string token boundary', () => {
  // A body that would parse as a picker, so only the info string decides.
  const body = '\n[{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}]\n```';

  it.each(['agenthub:asking', 'agenthub:ask-preview', 'agenthub:ask_answer', 'x-agenthub:ask'])(
    'does not treat ```%s as a picker fence',
    (info) => {
      const text = '```' + info + body;
      const { strippedText, asks } = extractAskBlocks(text);
      expect(asks).toEqual([]);
      expect(strippedText).toBe(text);
    },
  );

  it('still opens on the token followed by a same-line payload', () => {
    const { asks } = extractAskBlocks(
      '```agenthub:ask{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}```',
    );
    expect(asks).toHaveLength(1);
  });
});

// The single-line form finds its closing delimiter by walking the payload's
// JSON structure. Taking the first fence run instead truncates the payload the
// moment an option preview contains one.
describe('extractAskBlocks — same-line block whose payload contains a fence run', () => {
  const withPreviews = (previewA: string, previewB: string) =>
    JSON.stringify({
      question: 'Which snippet?',
      options: [
        { label: 'A', preview: previewA },
        { label: 'B', preview: previewB },
      ],
    });

  it('closes on the real delimiter, not on a fence inside a preview', () => {
    const text = '```agenthub:ask ' + withPreviews('```js', '```ts') + '```';
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options.map((o) => o.preview)).toEqual(['```js', '```ts']);
    expect(strippedText).toBe('');
  });

  it('handles a preview holding a complete fenced snippet with escaped newlines', () => {
    const preview = '```js\\nconst x = 1;\\n```';
    const text =
      'Pick:\n\n```agenthub:ask {"question":"Q?","options":[{"label":"A","preview":"' +
      preview +
      '"},{"label":"B"}]}```\n\nThanks.';
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options[0].preview).toContain('const x = 1;');
    expect(strippedText).toBe('Pick:\n\nThanks.');
  });

  it('closes a tilde single-line block past a backtick preview', () => {
    const text = '~~~agenthub:ask ' + withPreviews('```js', '~~~ts') + '~~~';
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options[1].preview).toBe('~~~ts');
  });

  it('leaves a same-line block with an unparseable payload raw', () => {
    const text = '```agenthub:ask {"question":"Q?","options":[{"label":"```js"}```';
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
    expect(strippedText).toBe(text);
  });
});

// A block closes only on the *opener's* fence character and length. Checking
// the candidate line's own properties instead — the shape the pre-rewrite
// server scanner had — makes every standalone fence run a closer, so an inner
// fence line ends the block early and the picker never renders.
describe('scanFences — a block closes only on its own opener', () => {
  const payload = '[{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}]';

  it('does not close a tilde ask on a backtick fence line of equal length', () => {
    const text = ['~~~agenthub:ask', '```', payload, '~~~'].join('\n');
    const { askFences } = scanFences(text);
    expect(askFences).toHaveLength(1);
    expect(askFences[0].payload).toContain('```');
    expect(askFences[0].end).toBe(text.length);
    expect(extractAskBlocks(text).asks).toHaveLength(1);
  });

  it('does not close a four-backtick ask on a shorter backtick fence line', () => {
    const text = ['````agenthub:ask', '```', payload, '````'].join('\n');
    const { askFences } = scanFences(text);
    expect(askFences).toHaveLength(1);
    expect(askFences[0].payload).toContain('```');
    expect(askFences[0].end).toBe(text.length);
    expect(extractAskBlocks(text).asks).toHaveLength(1);
  });

  it('does not close a four-backtick ask on a tilde fence line', () => {
    const text = ['````agenthub:ask', '~~~~', payload, '````'].join('\n');
    const { askFences } = scanFences(text);
    expect(askFences).toHaveLength(1);
    expect(extractAskBlocks(text).asks).toHaveLength(1);
  });

  it('applies the same rule to a locked block, keeping a nested ask inert', () => {
    // If the ```` doc block ended at the inner ~~~~, the example ask below it
    // would fall outside any locked body and render as a live picker.
    const text = ['````text', '~~~~', '```agenthub:ask', payload, '```', '````'].join('\n');
    const { askFences, lockedBodies } = scanFences(text);
    expect(askFences).toEqual([]);
    expect(lockedBodies).toHaveLength(1);
    expect(extractAskBlocks(text).asks).toEqual([]);
  });
});

describe('extractAskBlocks — stripping order', () => {
  it('strips an XML ask that precedes a fenced ask without corrupting prose', () => {
    const xml =
      '<agenthub:ask>{"question":"First?","options":[{"label":"A"},{"label":"B"}]}</agenthub:ask>';
    const fenced =
      '```agenthub:ask\n[{"question":"Second?","options":[{"label":"C"},{"label":"D"}]}]\n```';
    const text = `Intro.\n\n${xml}\n\nMiddle.\n\n${fenced}\n\nOutro.`;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks.map((a) => a.questions[0].question)).toEqual(['First?', 'Second?']);
    expect(strippedText).toBe('Intro.\n\nMiddle.\n\nOutro.');
  });
});
