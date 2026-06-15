// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// The mobile app imports shared utilities from `<repoRoot>/shared`, which lives
// outside the Expo project root. Metro will not bundle files outside its watched
// folders, so the repo root must be added explicitly. Hierarchical node_modules
// lookup is left at Metro's default so `expo`'s nested transitive deps still resolve.
config.watchFolders = [repoRoot];

module.exports = config;
