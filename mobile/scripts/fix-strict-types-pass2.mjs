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

  // Lookup map constants
  text = text.replace(
    /^const ([A-Z][A-Z0-9_]*) = \{/gm,
    'const $1: Record<string, any> = {',
  );
  text = text.replace(
    /^const ([A-Z][A-Za-z0-9_]*) = \{/gm,
    (match, name) => {
      if (match.includes('Record<string, any>')) return match;
      const mapNames =
        /^(EMPTY_|STATUS_|SEVERITY_|TYPE_|STATE_|ENGINE_|TOOL_|TODO_|BADGE_|VERDICT_|EVENT_|PERMISSION_|LINE_|TONE_|CATEGORY_|FRAMEWORK_|SUBAGENT_|ICON|ICONS|COLOR|COLORS|ACTIVITY_|SUPPORT_|PR_|PRIORITY_|REVIEW_|DEFAULT_CONFIG|HUB_LUCIDE)/;
      if (mapNames.test(name)) return `const ${name}: Record<string, any> = {`;
      return match;
    },
  );

  // Navigation typing
  text = text.replace(/\buseNavigation\(\)/g, 'useNavigation<any>()');

  // Module-level caches
  text = text.replace(/\blet (_cached[A-Za-z]+) = null;/g, 'let $1: any = null;');
  text = text.replace(/\blet (_cached[A-Za-z]+) = undefined;/g, 'let $1: any = undefined;');

  // Uninitialized arrays in let
  text = text.replace(/\blet ([a-zA-Z_][a-zA-Z0-9_]*) = \[\];/g, 'let $1: any[] = [];');
  text = text.replace(/\blet ([a-zA-Z_][a-zA-Z0-9_]*) = \{\};/g, 'let $1: any = {};');

  // Markdown style props
  text = text.replace(/<Markdown style=\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, '<Markdown style={$1 as any}');

  // useState with object literal forms that infer {} for nested access
  text = text.replace(/\buseState\(\{\}\)/g, 'useState<any>({})');
  text = text.replace(/\buseState\(\{ name:/g, 'useState<any>({ name:');
  text = text.replace(/\buseState\(\{ key:/g, 'useState<any>({ key:');
  text = text.replace(/\buseState\(\{ title:/g, 'useState<any>({ title:');

  // Form state objects
  text = text.replace(/\bconst \[([a-zA-Z]+), set[A-Z]/g, (m) => m); // noop

  // fetch mock in tests
  if (file.endsWith('.test.ts')) {
    text = text.replace(/\blet mockFetch;/g, 'let mockFetch: any;');
    text = text.replace(/\blet calls = \[\];/g, 'let calls: any[] = [];');
    text = text.replace(/\bglobal\.fetch = mockFetch;/g, 'global.fetch = mockFetch as any;');
  }

  // Headers spread for fetch
  text = text.replace(
    /headers:\s*\{\s*\.\.\.(getAuthHeaders\(\))\s*\}/g,
    'headers: { ...$1 } as Record<string, string>',
  );

  // expo-file-system legacy API
  text = text.replace(/FileSystem\.cacheDirectory/g, '(FileSystem as any).cacheDirectory');

  if (text !== orig) fs.writeFileSync(file, text);
}

const files = [...walk(ROOT), path.join(ROOT, 'App.tsx')].filter((f) => fs.existsSync(f));
for (const file of files) fixFile(file);
console.log(`Pass 2 processed ${files.length} files`);
