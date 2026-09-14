import { readFileSync } from 'fs';
import path from 'path';

export interface TodoAppValidation {
  ok: boolean;
  reasons: string[];
}

/**
 * Assert the disposable fixture app still has a browser-testable add-and-list
 * flow. Pure filesystem checks: no browser, no CLI.
 */
export function validateTodoApp(
  appDir: string,
  opts: { requireComplete?: boolean } = {},
): TodoAppValidation {
  const reasons: string[] = [];
  let html: string | null = null;
  let js: string | null = null;
  try {
    html = readFileSync(path.join(appDir, 'index.html'), 'utf8');
  } catch {
    reasons.push('index.html is missing');
  }
  try {
    js = readFileSync(path.join(appDir, 'app.js'), 'utf8');
  } catch {
    reasons.push('app.js is missing');
  }
  if (html !== null) {
    if (!html.includes('id="add-form"')) reasons.push('add form is missing');
    if (!html.includes('id="todo-input"')) reasons.push('todo input is missing');
    if (!html.includes('id="todo-list"')) reasons.push('todo list is missing');
  }
  if (js !== null) {
    if (!js.includes("getElementById('add-form')")) reasons.push('add-form handler is missing');
    if (!js.includes('todos.push')) reasons.push('add-to-list path is missing');
    if (opts.requireComplete && !/todo\.done|completeTodo|dataset\.complete/.test(js)) {
      reasons.push('complete-todo implementation is missing');
    }
  }
  return { ok: reasons.length === 0, reasons };
}
