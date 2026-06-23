#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'scripts') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

function fixFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  const orig = text;

  text = text.replace(/\bconst flat = \{\};/g, 'const flat: Record<string, any> = {};');
  text = text.replace(/\blet textBuf;/g, 'let textBuf: any;');
  text = text.replace(/\blet exploredBuf;/g, 'let exploredBuf: any;');
  text = text.replace(/\blet subscription;/g, 'let subscription: any;');
  text = text.replace(/\blet collected;/g, 'let collected: any[] = [];');
  text = text.replace(/\blet total;/g, 'let total: any;');
  text = text.replace(/\blet calls = \[\];/g, 'let calls: any[] = [];');

  // lowercase lookup maps
  text = text.replace(
    /^const ([a-z][a-zA-Z0-9_]*) = \{$/gm,
    (match, name) => {
      if (match.includes('Record<string, any>')) return match;
      const hints = /^(opts|flat|next|raw|map|lookup|labels|styles|meta|acc|counts|out|result|payload|body|entry|badge|tone|video|mime|ext|form|state|patch|headers|groups|buckets|dots|rank|removals|additions)$/;
      if (hints.test(name)) return `const ${name}: Record<string, any> = {`;
      return match;
    },
  );

  // export const maps in utils
  if (file.includes('/utils/')) {
    text = text.replace(
      /^export const ([A-Z_][A-Z0-9_]*) = \{/gm,
      (match, name) => {
        if (match.includes('Record<string, any>')) return match;
        return `export const ${name}: Record<string, any> = {`;
      },
    );
  }

  // fetch headers
  text = text.replace(
    /headers:\s*\{\s*\.\.\.getAuthHeaders\(\),\s*'Content-Type':/g,
    "headers: { ...getAuthHeaders(), 'Content-Type':",
  );
  text = text.replace(
    /headers:\s*\{\s*\.\.\.getAuthHeaders\(\),\s*'Content-Type':\s*'application\/json'\s*\}/g,
    "headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' } as Record<string, string>",
  );

  // form state with useState object literal missing fields
  text = text.replace(
    /\buseState\(\{\s*name:\s*''/g,
    "useState<any>({ name: ''",
  );
  text = text.replace(
    /\buseState\(\{\s*title:\s*''/g,
    "useState<any>({ title: ''",
  );

  if (file.endsWith('.test.ts')) {
    // Non-null assertions in tests for strict null checks
    text = text.replace(/expect\((\w+)\.(\w+)\)/g, (m, v, prop) => {
      if (['toBe', 'toEqual', 'toMatch', 'toContain', 'toBeTruthy'].some((_) => false)) return m;
      return m;
    });
  }

  if (text !== orig) fs.writeFileSync(file, text);
}

for (const file of [...walk(ROOT), path.join(ROOT, 'App.tsx')].filter((f) => fs.existsSync(f))) {
  fixFile(file);
}
console.log('Pass 3 complete');
