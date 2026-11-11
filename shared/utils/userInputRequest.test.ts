import { describe, it, expect } from 'vitest';
import {
  findCredentialRequestIds,
  isAwaitingUserReply,
  textRequestsUserInput,
  userInputKindsInText,
} from './userInputRequest.js';

const ASK = [
  'Pick one.',
  '```agenthub:ask',
  JSON.stringify({
    askId: 'lib',
    question: 'Which library?',
    header: 'Library',
    options: [
      { label: 'a', description: 'A' },
      { label: 'b', description: 'B' },
    ],
  }),
  '```',
].join('\n');

const CRED = [
  '```agenthub:credential-request',
  JSON.stringify({
    requestId: 'login',
    service: 'Tracker',
    fields: [{ key: 'password', label: 'Password', type: 'password' }],
  }),
  '```',
].join('\n');

const FORWARD = '```agenthub:forward\n{"projectId":"app","agentId":"ada","prompt":"Fix it"}\n```';

describe('userInputKindsInText', () => {
  it('names each kind of request in the text', () => {
    expect(userInputKindsInText(ASK)).toEqual(['ask']);
    expect(userInputKindsInText(CRED)).toEqual(['credential']);
    expect(userInputKindsInText(FORWARD)).toEqual(['forward']);
    expect(userInputKindsInText(`${FORWARD}\n${ASK}`)).toEqual(['ask', 'forward']);
    expect(userInputKindsInText('plain reply')).toEqual([]);
  });
});

describe('isAwaitingUserReply ignoreKinds', () => {
  const stamped = (kinds?: string[]) => [
    { role: 'user', content: 'Scheduled poller check-in' },
    {
      role: 'assistant',
      content: 'Two issues filed.',
      metadata: JSON.stringify({ awaitingUserInput: true, awaitingUserInputKinds: kinds }),
    },
  ];

  it('does not block on a forward-only stamp when forwards are ignored', () => {
    const messages = stamped(['forward']);
    expect(isAwaitingUserReply(messages)).toBe(true);
    expect(isAwaitingUserReply(messages, { ignoreKinds: ['forward'] })).toBe(false);
  });

  it('still blocks when an ask rides along with the forward', () => {
    expect(isAwaitingUserReply(stamped(['ask', 'forward']), { ignoreKinds: ['forward'] })).toBe(
      true,
    );
  });

  it('treats a stamp without kinds as blocking, since its kind is unknown', () => {
    expect(isAwaitingUserReply(stamped(), { ignoreKinds: ['forward'] })).toBe(true);
  });

  it('applies ignoreKinds to fences still in the text', () => {
    const messages = [{ role: 'assistant', content: FORWARD }];
    expect(isAwaitingUserReply(messages, { ignoreKinds: ['forward'] })).toBe(false);
    expect(
      isAwaitingUserReply([{ role: 'assistant', content: CRED }], { ignoreKinds: ['forward'] }),
    ).toBe(true);
  });
});

describe('textRequestsUserInput', () => {
  it('detects an ask picker, a forward card, and a credential card', () => {
    expect(textRequestsUserInput(ASK)).toBe(true);
    expect(textRequestsUserInput(CRED)).toBe(true);
    expect(
      textRequestsUserInput(
        '```agenthub:forward\n{"projectId":"app","agentId":"ada","prompt":"Fix it"}\n```',
      ),
    ).toBe(true);
  });

  it('ignores prose, malformed blocks, and credential cards without fields', () => {
    expect(textRequestsUserInput('Should I use agenthub:ask here?')).toBe(false);
    expect(textRequestsUserInput('```agenthub:ask\nnot json\n```')).toBe(false);
    expect(
      textRequestsUserInput('```agenthub:credential-request\n{"requestId":"x","fields":[]}\n```'),
    ).toBe(false);
    expect(textRequestsUserInput(null)).toBe(false);
  });
});

describe('findCredentialRequestIds', () => {
  it('returns the request ids of well-formed cards', () => {
    expect(findCredentialRequestIds(`${CRED}\n\n${CRED.replace('login', 'second')}`)).toEqual([
      'login',
      'second',
    ]);
  });
});

describe('isAwaitingUserReply', () => {
  it('is true when the last assistant row asked and nobody replied', () => {
    expect(
      isAwaitingUserReply([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: CRED },
        { role: 'system', content: 'Paused' },
      ]),
    ).toBe(true);
  });

  it('reads the metadata stamp when the ask was lifted out of the text', () => {
    expect(
      isAwaitingUserReply([
        { role: 'assistant', content: 'Pick one.', metadata: '{"awaitingUserInput":true}' },
      ]),
    ).toBe(true);
    expect(
      isAwaitingUserReply([{ role: 'assistant', content: 'Done.', metadata: '{"wikiRag":{}}' }]),
    ).toBe(false);
  });

  it('is false once the user replies', () => {
    expect(
      isAwaitingUserReply([
        { role: 'assistant', content: ASK },
        { role: 'user', content: 'a' },
      ]),
    ).toBe(false);
  });
});
