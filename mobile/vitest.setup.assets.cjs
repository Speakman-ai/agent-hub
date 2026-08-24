// Static image assets have no Metro transformer under vitest's node
// environment. Component code loads them via `require('./x.png')`, which runs on
// Node's real `require` (vitest's createRequire) and bypasses Vite plugins /
// resolve aliases entirely — Node then tries to parse the raw PNG bytes as JS
// and throws "SyntaxError: Invalid or unexpected token".
//
// Register a Node module-extension handler for image types so those requires
// return a numeric stub (mirrors a React Native asset id). Runs as a vitest
// setupFile, before any test or component module is imported.
const Module = require('module');

const stubImageModule = (module) => {
  module.exports = 1;
};

for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']) {
  Module._extensions[ext] = stubImageModule;
}
