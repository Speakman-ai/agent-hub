import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { validateTodoApp } from './validate-todo-app.js';

describe('validateTodoApp', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('rejects empty index.html and app.js even when both exist', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'autopilot-empty-todo-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'index.html'), '');
    writeFileSync(path.join(dir, 'app.js'), '');
    const result = validateTodoApp(dir, { requireComplete: true });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'add form is missing',
        'todo input is missing',
        'todo list is missing',
        'add-form handler is missing',
        'add-to-list path is missing',
        'complete-todo implementation is missing',
      ]),
    );
  });
});
