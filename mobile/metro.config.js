// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const {
  sharedJsFallbackSpecifier,
  withAppNodeModulesResolverPaths,
} = require('./metro-shared-js-resolver.cjs');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// The mobile app imports shared utilities from `<repoRoot>/shared`, which lives
// outside the Expo project root. Metro will not bundle files outside its watched
// folders, so the repo root must be added explicitly. Hierarchical node_modules
// lookup is left at Metro's default so `expo`'s nested transitive deps still resolve.
config.watchFolders = [repoRoot];

// Some shared modules (e.g. `shared/hooks/*`) import `react`. When such a file is
// bundled, Metro resolves `react` hierarchically from the *importing* file's
// location — i.e. up the `shared/` tree — which finds nothing on EAS, where only
// `mobile/` gets `npm install` (`shared/node_modules` is git-ignored and never
// installed on the build server). That breaks the "Bundle JavaScript"/eager-bundle
// phase with "Unable to resolve module react from shared/...". Add the app's own
// `node_modules` as an additional resolver root so these repo-root imports always
// fall back to the copy installed alongside the Expo app. This augments (does not
// disable) hierarchical lookup, so `expo`'s nested transitive deps still resolve.
// Logic lives in `withAppNodeModulesResolverPaths` so it can be unit-tested.
config.resolver.nodeModulesPaths = withAppNodeModulesResolverPaths(
  config.resolver.nodeModulesPaths,
  path.join(projectRoot, 'node_modules'),
);

const sharedRoot = path.join(repoRoot, 'shared');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('@shared/')) {
    const subpath = moduleName.slice('@shared/'.length);
    return context.resolveRequest(context, path.join(sharedRoot, subpath), platform);
  }
  // Shared TS files use explicit ".js" ESM specifiers on relative sibling
  // imports; Metro resolves them literally and fails against the ".ts" source.
  // For imports originating inside shared/, fall back to the extension-stripped
  // specifier so sourceExts find the ".ts"/".tsx". Real ".js" files still win
  // because we only strip when the literal resolve throws.
  const fallback = sharedJsFallbackSpecifier(
    moduleName,
    context.originModulePath || '',
    sharedRoot,
  );
  if (fallback) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      return context.resolveRequest(context, fallback, platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
