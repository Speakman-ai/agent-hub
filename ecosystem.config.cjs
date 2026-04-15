/**
 * PM2 process file for production. The server entry is TypeScript; run it via tsx
 * (same as `npm run dev:server`), not `node index.js`.
 *
 * Usage on the server:
 *   cd ~/agent-hub && npm install && cd server && npm install
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup   # optional: resurrect on reboot
 */
const path = require('path');

const root = __dirname;
const serverDir = path.join(root, 'server');
const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

module.exports = {
  apps: [
    {
      name: 'agent-hub',
      cwd: serverDir,
      script: tsxCli,
      args: ['index.ts'],
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
