import { describe, it, expect } from 'vitest';
import { PUSH_SERVER_URL_KEY, tagPushData } from './pushServerTag';

describe('tagPushData', () => {
  it('adds the server URL without touching the original', () => {
    const data = { sessionId: 's1' };
    expect(tagPushData(data, 'https://one.test')).toEqual({
      sessionId: 's1',
      [PUSH_SERVER_URL_KEY]: 'https://one.test',
    });
    expect(data).toEqual({ sessionId: 's1' });
  });

  it('leaves data untagged when there is no server URL', () => {
    expect(tagPushData({ a: 1 }, null)).toEqual({ a: 1 });
    expect(tagPushData(undefined, '')).toEqual({});
  });
});
