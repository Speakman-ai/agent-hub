import { describe, it, expect } from 'vitest';
import {
  findCredentialRequestIds,
  isAwaitingUserReply,
  textRequestsUserInput,
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

describe('textRequestsUserInput', () => {
  it('detects an ask picker and a credential card', () => {
    expect(textRequestsUserInput(ASK)).toBe(true);
    expect(textRequestsUserInput(CRED)).toBe(true);
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
