import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hello } from './index.js';

test('hello() greets the default target', () => {
  assert.equal(hello(), 'Hello, world!');
});

test('hello() greets a named target', () => {
  assert.equal(hello('agent'), 'Hello, agent!');
});
