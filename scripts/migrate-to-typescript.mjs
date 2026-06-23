#!/usr/bin/env node
/**
 * Mechanical JS → TS migration helper.
 * Renames files and rewrites import paths per package conventions.
 *
 * Usage:
 *   node scripts/migrate-to-typescript.mjs shared/utils
 *   node scripts/migrate-to-typescript.mjs client/src --strip-extensions
 *   node scripts/migrate-to-typescript.mjs mobile/src --strip-extensions
 *   node scripts/migrate-to-typescript.mjs electron --server-imports
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const targetDir = args.find((a) => !a.startsWith('--'));
const stripExtensions = args.includes('--strip-extensions');
const serverImports = args.includes('--server-imports');

if (!targetDir) {
  console.error('Usage: node scripts/migrate-to-typescript.mjs <dir> [--strip-extensions] [--server-imports]');
  process.exit(1);
}

const root = path.resolve(targetDir);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function renameFile(file) {
  if (file.endsWith('.jsx')) {
    const next = file.replace(/\.jsx$/, '.tsx');
    fs.renameSync(file, next);
    return { from: file, to: next };
  }
  if (file.endsWith('.js') && !file.endsWith('.test.js') && !file.endsWith('.spec.js')) {
    if (file.endsWith('.config.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return null;
    const next = file.replace(/\.js$/, '.ts');
    fs.renameSync(file, next);
    return { from: file, to: next };
  }
  if (file.endsWith('.test.js')) {
    const next = file.replace(/\.test\.js$/, '.test.ts');
    fs.renameSync(file, next);
    return { from: file, to: next };
  }
  if (file.endsWith('.spec.js')) {
    const next = file.replace(/\.spec\.js$/, '.spec.ts');
    fs.renameSync(file, next);
    return { from: file, to: next };
  }
  return null;
}

function rewriteImports(file) {
  let text = fs.readFileSync(file, 'utf8');
  const orig = text;

  if (stripExtensions) {
    // Strip explicit .js/.jsx/.ts/.tsx from relative imports
    text = text.replace(
      /from\s+(['"])(\.\.?\/[^'"]+)\.(jsx|js|tsx|ts)\1/g,
      "from $1$2$1",
    );
    text = text.replace(
      /import\s+(['"])(\.\.?\/[^'"]+)\.(jsx|js|tsx|ts)\1/g,
      "import $1$2$1",
    );
    // shared relative → @shared alias
    text = text.replace(
      /from\s+(['"])(?:\.\.\/)+shared\/([^'"]+)\1/g,
      "from '@shared/$2'",
    );
    text = text.replace(
      /from\s+(['"])\.\.\/\.\.\/shared\/([^'"]+)\1/g,
      "from '@shared/$2'",
    );
  }

  if (serverImports) {
    // Keep .js suffix for ESM nodenext (imports .ts sources)
    text = text.replace(
      /from\s+(['"])(\.[^'"]+)\.ts\1/g,
      "from $1$2.js$1",
    );
  }

  if (text !== orig) fs.writeFileSync(file, text);
}

const allFiles = walk(root);
const renames = [];

for (const file of allFiles) {
  const r = renameFile(file);
  if (r) renames.push(r);
}

// Rewrite imports in all ts/tsx files under target
for (const file of walk(root)) {
  if (/\.(ts|tsx)$/.test(file)) rewriteImports(file);
}

console.log(`Renamed ${renames.length} files under ${root}`);
for (const r of renames.slice(0, 20)) console.log(`  ${path.relative(process.cwd(), r.from)} → ${path.basename(r.to)}`);
if (renames.length > 20) console.log(`  … and ${renames.length - 20} more`);
