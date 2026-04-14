import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const apiPort = process.env.VITE_API_PORT || 3051;
const clientVersion = JSON.parse(readFileSync('../package.json', 'utf-8')).version;

export default defineConfig({
  plugins: [react()],
  define: {
    // Expose the API port to the client so connection.js can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(clientVersion),
  },
  server: {
    port: 3050,
    host: '0.0.0.0',
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/uploads': `http://localhost:${apiPort}`,
    },
  },
});
