/**
 * Deterministic disposable BROWSER app fixture for the Autopilot acceptance
 * suite.
 *
 * The "app" is a real browser-facing todo application: an `index.html` with an
 * add form and a todo list, plus an `app.js` that renders todos into the DOM and
 * wires submit/click handlers. Verification is a browser journey: the deployed
 * app is loaded into an isolated DOM (jsdom) and driven the way a user would —
 * type into the input, submit the form, click Done / Edit — asserting on the
 * RENDERED DOM. So a cycle only verifies green when the deployed app's rendered
 * flow actually works. A backend/store that is correct but never updates the DOM
 * (a broken rendered flow) fails its journey, which a direct module call could
 * not catch.
 *
 * Everything is on-disk git state driven through jsdom. No real browser, CLI, or
 * network is involved. Used only by acceptance.test.ts.
 *
 * `jsdom` is a repo-root devDependency (the same one the client tests use); it
 * resolves from here via node module resolution, and the Finalize server-test
 * job installs the root devDependencies before running the server suite. A
 * local ambient declaration (`jsdom.d.ts`) types it, since the server tsconfig
 * does not include the DOM lib.
 */
import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

export type OpQuality = 'ok' | 'broken' | 'absent';
export type TodoOp = 'add' | 'list' | 'complete' | 'edit';
export type FeatureMap = Record<TodoOp, OpQuality>;

const BASELINE: FeatureMap = { add: 'ok', list: 'ok', complete: 'absent', edit: 'absent' };
const EDIT_TITLE = 'renamed';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8" /><title>Todos</title></head>',
  '<body>',
  '  <main id="app">',
  '    <h1>Todos</h1>',
  '    <form id="add-form">',
  '      <input id="todo-input" name="title" placeholder="What needs doing?" />',
  '      <button type="submit" id="add-btn">Add</button>',
  '    </form>',
  '    <ul id="todo-list"></ul>',
  '  </main>',
  '  <script src="./app.js"></script>',
  '</body>',
  '</html>',
  '',
].join('\n');

/**
 * Generate the browser app script. Quality controls the RENDERED flow, not just
 * the store: `broken` means the store mutation happens but the DOM is never
 * updated to reflect it; `absent` means the affordance is not wired/rendered.
 */
function renderAppJs(features: FeatureMap): string {
  // Submit handler variants (the "create a todo" rendered flow).
  const addWiring =
    features.add === 'absent'
      ? '// add is not wired'
      : features.add === 'broken'
        ? `form.addEventListener('submit', function (e) {
        e.preventDefault();
        var title = input.value.trim();
        if (title) { store.add(title); /* BUG: forgot to render() */ }
      });`
        : `form.addEventListener('submit', function (e) {
        e.preventDefault();
        var title = input.value.trim();
        if (title) { store.add(title); input.value = ''; render(); }
      });`;

  // Per-item control rendering. A control is only rendered when its op exists;
  // a "broken" control mutates the store but skips the re-render.
  const completeControl =
    features.complete === 'absent'
      ? ''
      : `        var doneBtn = document.createElement('button');
        doneBtn.className = 'complete';
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () {
          store.complete(it.id);
          ${features.complete === 'broken' ? '/* BUG: no re-render */' : 'render();'}
        });
        li.appendChild(doneBtn);`;
  const editControl =
    features.edit === 'absent'
      ? ''
      : `        var editBtn = document.createElement('button');
        editBtn.className = 'edit';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function () {
          store.edit(it.id, ${JSON.stringify(EDIT_TITLE)});
          ${features.edit === 'broken' ? '/* BUG: no re-render */' : 'render();'}
        });
        li.appendChild(editBtn);`;

  return `// disposable todo browser app (deterministic acceptance fixture)
(function () {
  var items = [];
  var nextId = 1;
  var store = {
    add: function (title) {
      var it = { id: nextId++, title: title, done: false };
      items.push(it);
      return it;
    },
    complete: function (id) {
      var it = items.filter(function (i) { return i.id === id; })[0];
      if (it) { it.done = true; }
      return it;
    },
    edit: function (id, title) {
      var it = items.filter(function (i) { return i.id === id; })[0];
      if (it) { it.title = title; }
      return it;
    },
    list: function () {
      return items.map(function (i) { return { id: i.id, title: i.title, done: i.done }; });
    }
  };

  function render() {
    var list = document.getElementById('todo-list');
    list.innerHTML = '';
    store.list().forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'todo' + (it.done ? ' done' : '');
      li.setAttribute('data-id', String(it.id));
      if (it.done) { li.setAttribute('data-done', 'true'); }
      var label = document.createElement('span');
      label.className = 'title';
      label.textContent = it.title;
      li.appendChild(label);
${completeControl}
${editControl}
      list.appendChild(li);
    });
  }

  function onReady() {
    var form = document.getElementById('add-form');
    var input = document.getElementById('todo-input');
    ${addWiring}
    render();
  }

  // The script tag is at the end of <body>, so the DOM already exists.
  onReady();
})();
`;
}

function writeApp(dir: string, features: FeatureMap): void {
  writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(dir, 'app.js'), renderAppJs(features));
  writeFileSync(path.join(dir, 'features.json'), JSON.stringify(features, null, 2));
}

function readFeatureMap(dir: string): FeatureMap {
  return JSON.parse(readFileSync(path.join(dir, 'features.json'), 'utf8')) as FeatureMap;
}

/** Map a pinned journey action to the todo operation it exercises. */
export function opForAction(action: string): TodoOp {
  const a = action.toLowerCase();
  if (a.includes('complete')) return 'complete';
  if (a.includes('edit') || a.includes('rename') || a.includes('title')) return 'edit';
  if (a.includes('create') || a.includes('add') || a.includes('submit') || a.includes('new'))
    return 'add';
  return 'list';
}

/** Seed a fresh git repo with the baseline browser app. Returns the baseline SHA. */
export function seedObservableApp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeApp(dir, { ...BASELINE });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.test']);
  git(dir, ['config', 'user.name', 'Autopilot Fixture']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'baseline todo app']);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Implement a todo operation (ok or intentionally broken) and commit it. */
export function implementFeature(
  dir: string,
  op: TodoOp,
  opts: { quality?: OpQuality } = {},
): string {
  const features = readFeatureMap(dir);
  features[op] = opts.quality ?? 'ok';
  writeApp(dir, features);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', `implement ${op} (${features[op]})`, '--allow-empty']);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Commit that changes nothing about behavior (a genuine no-op improvement). */
export function commitNoop(dir: string, label: string): string {
  git(dir, ['commit', '-m', `no-op: ${label}`, '--allow-empty']);
  return git(dir, ['rev-parse', 'HEAD']);
}

export function headSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Isolated deployment: copy the source tree at its current HEAD into a separate origin dir. */
export function deployApp(srcDir: string, deployDir: string): void {
  rmSync(deployDir, { recursive: true, force: true });
  mkdirSync(path.dirname(deployDir), { recursive: true });
  cpSync(srcDir, deployDir, { recursive: true });
}

/** Load the deployed app into an isolated DOM and return its window. */
function loadDeployedApp(deployDir: string): any {
  const html = readFileSync(path.join(deployDir, 'index.html'), 'utf8');
  const appJs = readFileSync(path.join(deployDir, 'app.js'), 'utf8');
  // Inline the deployed script so the DOM executes it deterministically with no
  // external resource loading (and thus no network).
  const inlined = html.replace('<script src="./app.js"></script>', `<script>\n${appJs}\n</script>`);
  const dom = new JSDOM(inlined, { runScripts: 'dangerously' });
  return dom.window;
}

function submitTodo(window: any, title: string): void {
  const doc = window.document;
  doc.getElementById('todo-input').value = title;
  doc
    .getElementById('add-form')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function renderedTitles(window: any): string[] {
  return Array.from(window.document.querySelectorAll('#todo-list li .title')).map(
    (n: any) => n.textContent as string,
  );
}

/**
 * Drive a real browser journey against the DEPLOYED app through the rendered DOM
 * and report whether the user-visible flow works.
 */
export function runBrowserJourney(deployDir: string, op: TodoOp): boolean {
  try {
    const window = loadDeployedApp(deployDir);
    const doc = window.document;
    switch (op) {
      case 'add': {
        submitTodo(window, 'buy milk');
        return renderedTitles(window).includes('buy milk');
      }
      case 'list': {
        submitTodo(window, 'first');
        submitTodo(window, 'second');
        return (
          doc.querySelectorAll('#todo-list li').length === 2 &&
          renderedTitles(window).join(',') === 'first,second'
        );
      }
      case 'complete': {
        submitTodo(window, 'a');
        const btn = doc.querySelector('#todo-list li .complete');
        if (!btn) return false;
        btn.dispatchEvent(new window.Event('click', { bubbles: true }));
        const li = doc.querySelector('#todo-list li');
        return !!li && li.getAttribute('data-done') === 'true';
      }
      case 'edit': {
        submitTodo(window, 'a');
        const btn = doc.querySelector('#todo-list li .edit');
        if (!btn) return false;
        btn.dispatchEvent(new window.Event('click', { bubbles: true }));
        const title = doc.querySelector('#todo-list li .title');
        return !!title && title.textContent === EDIT_TITLE;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
