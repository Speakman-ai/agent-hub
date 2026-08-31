'use strict';

const path = require('path');

/**
 * Shared TS modules use explicit ".js" ESM specifiers on their relative sibling
 * imports (repo convention — `tsc` and Vite remap ".js" -> ".ts"/".tsx" at
 * resolve time). Metro's resolver does NOT remap: a runtime
 * `import { x } from './captureTodo.js'` inside shared/ is resolved literally
 * and fails against captureTodo.ts, which is what breaks the native (EAS) iOS
 * bundle in the "Bundle JavaScript" phase.
 *
 * Given a module request, decide whether to offer an extension-stripped
 * fallback so Metro's sourceExts can find the ".ts" source. We only remap
 * relative ".js" imports that ORIGINATE inside the shared tree, so app code and
 * node_modules (which may ship real ".js" files) are untouched.
 *
 * @returns the fallback specifier (moduleName without the trailing ".js") when
 *   the import is a relative ".js" originating inside `sharedRoot`, else null.
 */
function sharedJsFallbackSpecifier(moduleName, originModulePath, sharedRoot) {
  if (typeof moduleName !== 'string' || typeof originModulePath !== 'string') {
    return null;
  }
  if (typeof sharedRoot !== 'string' || sharedRoot.length === 0) {
    return null;
  }
  if (!moduleName.endsWith('.js')) return null;
  if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) return null;

  const normalizedRoot = sharedRoot.endsWith(path.sep) ? sharedRoot : sharedRoot + path.sep;
  if (!originModulePath.startsWith(normalizedRoot)) return null;

  return moduleName.slice(0, -'.js'.length);
}

module.exports = { sharedJsFallbackSpecifier };
