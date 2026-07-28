/**
 * Guards the route layer against imports that nothing references.
 *
 * `@typescript-eslint/no-unused-vars` is configured as a warning, so a dead
 * import can sit in a route file indefinitely — which is how
 * `detectComposePreview` survived in `projects.ts` after its only caller was
 * removed. This test fails the build instead.
 *
 * Scope is imports only, never unused locals: unused locals include `deps`
 * destructures and assigned-but-unread results where deletion can change
 * behavior, whereas removing an unreferenced import cannot.
 *
 * ## Why scope analysis rather than an identifier scan
 *
 * Two earlier hand-rolled versions of this detector were wrong in the same
 * direction — they failed *open*, marking a dead import live and silently
 * missing the regressions the guard exists to catch:
 *
 *   1. Counting every `Identifier` node treated property positions as usage,
 *      so `import { foo }` + `{ foo: 1 }` or `obj.foo` looked live.
 *   2. Filtering those out by parent-node kind still ignored lexical scope, so
 *      `import { foo }` + `function f(foo) { return foo }` looked live — the
 *      reference resolves to the parameter, not the import.
 *
 * Both are symptoms of approximating a binder. `@typescript-eslint/parser`
 * ships a real one, so we use it: `parseForESLint` returns a `scopeManager`
 * that resolves every reference to the binding it actually points at. An
 * import is dead iff its module-scope variable has zero resolved references.
 * Shadowing, property names, type positions, and re-exports all fall out
 * correctly instead of needing a special case each.
 *
 * The parser is a root devDependency (it backs `eslint.config.js`), resolved
 * here by Node walking up from `server/`. Every CI job that runs server tests
 * installs root deps first, and a missing install fails loudly at import time
 * rather than silently skipping the guard.
 */
import { describe, it, expect } from 'vitest';
import { parseForESLint } from '@typescript-eslint/parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every route source file, recursively, as paths relative to ROUTES_DIR. */
function routeFiles(dir: string = ROUTES_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...routeFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * Imported binding names that nothing in the file references.
 *
 * A module-scope variable whose only definition is an `ImportBinding` and
 * which has no resolved references is a dead import. References are resolved
 * by the parser's scope manager, so an identifier that resolves to a shadowing
 * parameter or local does not keep the import alive.
 */
function deadImportsInSource(text: string, fileName = 'source.ts'): string[] {
  const { scopeManager } = parseForESLint(text, {
    range: true,
    loc: true,
    sourceType: 'module',
    filePath: fileName,
  });
  const moduleScope = scopeManager?.scopes.find((s) => s.type === 'module');
  if (!moduleScope) return [];

  return moduleScope.variables
    .filter((v) => v.defs.some((d) => d.type === 'ImportBinding') && v.references.length === 0)
    .map((v) => v.name)
    .sort();
}

describe('server/routes — no dead imports', () => {
  const files = routeFiles();

  it('finds route files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('scans nested route subdirectories, not just the top level', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-routes-'));
    try {
      fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
      fs.writeFileSync(path.join(root, 'top.ts'), '');
      fs.writeFileSync(path.join(root, 'skipme.test.ts'), '');
      fs.writeFileSync(path.join(root, 'nested', 'mid.ts'), '');
      fs.writeFileSync(path.join(root, 'nested', 'deeper', 'leaf.ts'), '');
      expect(routeFiles(root)).toEqual([
        path.join('nested', 'deeper', 'leaf.ts'),
        path.join('nested', 'mid.ts'),
        'top.ts',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('every imported binding in every route file is referenced', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const dead = deadImportsInSource(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'), f);
      if (dead.length) offenders.push(`${f}: ${dead.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  describe('detector', () => {
    const dead = (src: string) => deadImportsInSource(src);

    it('flags unreferenced value and type imports', () => {
      expect(
        dead(
          "import { alive, gone } from './x.js';\n" +
            "import type { GoneType } from './y.js';\n" +
            'export const v = alive();\n',
        ),
      ).toEqual(['GoneType', 'gone']);
    });

    it('ignores side-effect imports', () => {
      expect(dead("import './register.js';\n")).toEqual([]);
    });

    it('flags unreferenced default and namespace imports', () => {
      expect(dead("import def from './a.js';\nimport * as ns from './b.js';\n")).toEqual([
        'def',
        'ns',
      ]);
      expect(
        dead(
          "import def from './a.js';\nimport * as ns from './b.js';\nexport const v = def(ns);\n",
        ),
      ).toEqual([]);
    });

    // ── Lexical shadowing: the reference belongs to the inner binding ──
    it('does not count a shadowing function parameter as usage', () => {
      expect(
        dead("import { foo } from './x.js';\nexport function f(foo: string) {\n  return foo;\n}\n"),
      ).toEqual(['foo']);
    });

    it('does not count a shadowing arrow parameter as usage', () => {
      expect(
        dead("import { foo } from './x.js';\nexport const g = (foo: number) => foo;\n"),
      ).toEqual(['foo']);
    });

    it('does not count a shadowing local variable as usage', () => {
      expect(
        dead(
          "import { foo } from './x.js';\nexport function f() {\n  const foo = 1;\n  return foo;\n}\n",
        ),
      ).toEqual(['foo']);
    });

    it('does not count a shadowing nested block binding as usage', () => {
      expect(
        dead(
          "import { foo } from './x.js';\nexport function f() {\n  {\n    let foo = 2;\n    return foo;\n  }\n}\n",
        ),
      ).toEqual(['foo']);
    });

    it('does not count a shadowing catch binding as usage', () => {
      expect(
        dead(
          "import { foo } from './x.js';\nexport function f() {\n  try {\n    g();\n  } catch (foo) {\n    return foo;\n  }\n}\n",
        ),
      ).toEqual(['foo']);
    });

    it('still sees a real reference alongside an inner shadow', () => {
      expect(
        dead(
          "import { foo } from './x.js';\nexport function f(foo: string) {\n  return foo;\n}\nexport const v = foo();\n",
        ),
      ).toEqual([]);
    });

    // ── Property positions are not references ──
    it('does not count an object-literal key as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport const value = { foo: 1 };\n")).toEqual([
        'foo',
      ]);
    });

    it('does not count a property access as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport const v = obj.foo;\n")).toEqual(['foo']);
      expect(dead("import { foo } from './x.js';\nexport const v = obj?.foo;\n")).toEqual(['foo']);
    });

    it('does not count an interface or class member name as usage', () => {
      expect(
        dead("import { foo } from './x.js';\nexport interface I {\n  foo: string;\n}\n"),
      ).toEqual(['foo']);
      expect(
        dead("import { foo } from './x.js';\nexport class C {\n  foo() {\n    return 1;\n  }\n}\n"),
      ).toEqual(['foo']);
    });

    it('does not count a qualified type name segment as usage', () => {
      expect(dead("import { Foo } from './x.js';\nexport type T = ns.Foo;\n")).toEqual(['Foo']);
    });

    it('does not count a renamed destructuring property as usage', () => {
      expect(
        dead("import { foo } from './x.js';\nconst { foo: local } = obj;\nexport { local };\n"),
      ).toEqual(['foo']);
    });

    // ── Positions that genuinely ARE references and must still count ──
    it('counts shorthand property assignment as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport const value = { foo };\n")).toEqual([]);
    });

    it('counts the object side of a property access as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport const v = foo.bar;\n")).toEqual([]);
    });

    it('counts a re-export as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport { foo };\n")).toEqual([]);
      expect(dead("import { foo } from './x.js';\nexport { foo as renamed };\n")).toEqual([]);
    });

    it('counts a computed property key as usage', () => {
      expect(dead("import { foo } from './x.js';\nexport const v = { [foo]: 1 };\n")).toEqual([]);
    });

    it('counts type-position usage as usage', () => {
      expect(
        dead(
          "import type { Foo } from './x.js';\nexport function f(a: Foo): void {\n  void a;\n}\n",
        ),
      ).toEqual([]);
      expect(dead("import type { Foo } from './x.js';\nexport type T = Foo.Bar;\n")).toEqual([]);
      expect(dead("import type { T } from './x.js';\nexport const v: Array<T> = [];\n")).toEqual(
        [],
      );
    });

    it('counts the qualified-name left side as usage', () => {
      expect(dead("import * as ns from './x.js';\nexport type T = ns.Thing;\n")).toEqual([]);
    });

    it('counts an extends clause as usage', () => {
      expect(dead("import { Base } from './x.js';\nexport class C extends Base {}\n")).toEqual([]);
    });
  });
});
