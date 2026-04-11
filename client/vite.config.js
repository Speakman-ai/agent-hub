import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.VITE_API_PORT || 3051;

export default defineConfig({
  plugins: [react()],
  define: {
    // Expose the API port to the client so connection.js can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
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
