import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HUB_ICON_NAMES } from './hubIconNames.js';
import { HUB_NATIVE_ICONS } from './hubIconNative.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Extract the keys of the `HUB_LUCIDE_ICONS` object literal from a HubIcon
 * source file. Entries look like `Activity,` (shorthand) or
 * `BarChart3: ChartColumn,` (aliased) — in both cases the KEY is the leading
 * identifier. We parse statically because the HubIcon components import
 * `lucide-react-native`, which the Node-environment vitest can't evaluate.
 */
function lucideMapKeys(relPath) {
  const src = readFileSync(resolve(here, relPath), 'utf8');
  const block = src.match(/HUB_LUCIDE_ICONS\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error(`HUB_LUCIDE_ICONS object not found in ${relPath}`);
  const keys = new Set();
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*[,:]/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Regression: a name added to HUB_ICON_NAMES without a matching Lucide
// component registration makes HubIcon.{native,web}.js throw at import time
// (the validation loop), which crashes the app on startup. These files import
// `lucide-react-native` so they can't be imported here; assert statically.
describe('HubIcon registry consistency', () => {
  for (const relPath of ['../components/HubIcon.native.js', '../components/HubIcon.web.js']) {
    it(`registers a Lucide component for every HUB_ICON_NAME in ${relPath}`, () => {
      const keys = lucideMapKeys(relPath);
      const missing = HUB_ICON_NAMES.filter((name) => !keys.has(name));
      expect(missing, `missing Lucide mapping(s) in ${relPath}`).toEqual([]);
    });
  }

  it('every HUB_ICON_NAME also has a native font-glyph fallback', () => {
    const missing = HUB_ICON_NAMES.filter((name) => !HUB_NATIVE_ICONS[name]);
    expect(missing).toEqual([]);
  });
});
