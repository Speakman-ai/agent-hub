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

/**
 * Prepend the mobile app's own `node_modules` to Metro's resolver roots.
 *
 * The app imports shared modules from `<repoRoot>/shared`, some of which
 * `import 'react'`. On EAS only `mobile/` gets `npm install`, so Metro's
 * hierarchical lookup up the `shared/` tree finds no `react` and the eager
 * "Bundle JavaScript" phase fails with "Unable to resolve module react from
 * shared/...". Adding the app dir as an explicit resolver root makes these
 * repo-root imports fall back to the copy installed alongside the Expo app.
 *
 * This AUGMENTS hierarchical lookup — it never replaces the roots Metro/Expo
 * already configured, so `expo`'s nested transitive deps still resolve. The
 * app dir is placed first and de-duplicated so it is never listed twice.
 *
 * @param existingPaths the resolver's current `nodeModulesPaths` (may be
 *   undefined when Expo leaves it unset)
 * @param appNodeModules absolute path to `mobile/node_modules`
 * @returns the new resolver-roots array with `appNodeModules` first
 */
function withAppNodeModulesResolverPaths(existingPaths, appNodeModules) {
  const existing = Array.isArray(existingPaths) ? existingPaths : [];
  return [appNodeModules, ...existing.filter((p) => p !== appNodeModules)];
}

module.exports = { sharedJsFallbackSpecifier, withAppNodeModulesResolverPaths };
