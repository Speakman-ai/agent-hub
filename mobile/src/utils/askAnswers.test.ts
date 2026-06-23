// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { extractSubmittedAskIds, stripAskAnswerBlocks } from './askAnswers';
describe('extractSubmittedAskIds', () => {
    it('returns an empty set for an empty or missing list', () => {
        expect(extractSubmittedAskIds([]).size).toBe(0);
        expect(extractSubmittedAskIds(null).size).toBe(0);
        expect(extractSubmittedAskIds(undefined).size).toBe(0);
    });
    it('ignores assistant messages (only user-authored answers count)', () => {
        const messages = [
            {
                role: 'assistant',
                content: 'Here are my answers:\n\n```agenthub:ask:answer\n{"askId":"ask-x","answers":{}}\n```',
            },
        ];
        expect(extractSubmittedAskIds(messages).size).toBe(0);
    });
    it('extracts the askId from a single user answer block', () => {
        const messages = [
            {
                role: 'user',
                content: 'Here are my answers:\n\n```agenthub:ask:answer\n{"askId":"ask-abc","answers":{"Q?":"a"},"annotations":{}}\n```',
            },
        ];
        const ids = extractSubmittedAskIds(messages);
        expect(ids.size).toBe(1);
        expect(ids.has('ask-abc')).toBe(true);
    });
    it('extracts multiple askIds across many messages', () => {
        const messages = [
            { role: 'user', content: 'hello' },
            {
                role: 'user',
                content: '```agenthub:ask:answer\n{"askId":"ask-1","answers":{}}\n```',
            },
            { role: 'assistant', content: 'ok' },
            {
                role: 'user',
                content: '```agenthub:ask:answer\n{"askId":"ask-2","answers":{}}\n```',
            },
        ];
        const ids = extractSubmittedAskIds(messages);
        expect(ids.size).toBe(2);
        expect(ids.has('ask-1')).toBe(true);
        expect(ids.has('ask-2')).toBe(true);
    });
    it('skips malformed JSON answer blocks without throwing', () => {
        const messages = [
            {
                role: 'user',
                content: '```agenthub:ask:answer\nnot-json\n```',
            },
            {
                role: 'user',
                content: '```agenthub:ask:answer\n{"askId":"ask-ok","answers":{}}\n```',
            },
        ];
        const ids = extractSubmittedAskIds(messages);
        expect(ids.size).toBe(1);
        expect(ids.has('ask-ok')).toBe(true);
    });
    it('skips blocks that lack an askId field', () => {
        const messages = [
            {
                role: 'user',
                content: '```agenthub:ask:answer\n{"answers":{"Q?":"a"}}\n```',
            },
        ];
        expect(extractSubmittedAskIds(messages).size).toBe(0);
    });
    it('handles a single message containing multiple answer blocks', () => {
        const messages = [
            {
                role: 'user',
                content: '```agenthub:ask:answer\n{"askId":"ask-1","answers":{}}\n```\n' +
                    '```agenthub:ask:answer\n{"askId":"ask-2","answers":{}}\n```',
            },
        ];
        const ids = extractSubmittedAskIds(messages);
        expect(ids.size).toBe(2);
    });
});
describe('stripAskAnswerBlocks', () => {
    it('returns non-string inputs unchanged', () => {
        expect(stripAskAnswerBlocks(null)).toBe(null);
        expect(stripAskAnswerBlocks(undefined)).toBe(undefined);
        expect(stripAskAnswerBlocks(42)).toBe(42);
    });
    it('returns content without an answer block unchanged', () => {
        expect(stripAskAnswerBlocks('hello world')).toBe('hello world');
        expect(stripAskAnswerBlocks('```js\nconsole.log(1)\n```')).toBe('```js\nconsole.log(1)\n```');
    });
    it('strips the full "Here are my answers" + fenced block payload emitted by <AskUserQuestion>', () => {
        const content = 'Here are my answers:\n\n```agenthub:ask:answer\n' +
            '{\n  "askId": "ask-abc",\n  "answers": {"Q?": "a"},\n  "annotations": {}\n}\n' +
            '```';
        expect(stripAskAnswerBlocks(content)).toBe('');
    });
    it('strips a bare fenced block (without the "Here are my answers" prefix)', () => {
        const content = '```agenthub:ask:answer\n{"askId":"ask-1","answers":{}}\n```';
        expect(stripAskAnswerBlocks(content)).toBe('');
    });
    it('preserves surrounding prose while removing the block', () => {
        const content = 'Sounds good — ' +
            '```agenthub:ask:answer\n{"askId":"ask-1","answers":{"Q":"y"}}\n```' +
            ' thanks!';
        // Surrounding prose is kept; only the fenced block is excised. The
        // trailing/leading whitespace is trimmed by the helper.
        expect(stripAskAnswerBlocks(content)).toBe('Sounds good —  thanks!');
    });
    it('strips multiple answer blocks in one message', () => {
        const content = '```agenthub:ask:answer\n{"askId":"a","answers":{}}\n```\n' +
            '```agenthub:ask:answer\n{"askId":"b","answers":{}}\n```';
        expect(stripAskAnswerBlocks(content)).toBe('');
    });
});
