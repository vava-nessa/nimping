/**
 * @file web/vite.config.js
 * @description Vite config with proxy for backend API + Socket.IO (with WebSocket upgrade).
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  root: 'web',
  // 📖 Force a single React instance across the app + every dependency graph
  // 📖 (react-table, react-virtual, tabler…), same as the root vite.config.js
  // 📖 used for production builds. Without this, pnpm's nested peer-dep
  // 📖 resolution can make Vite's esbuild pre-bundler ship two copies of
  // 📖 React → "Invalid hook call" crashes at runtime in dev too.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5179,
    proxy: {
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        ws: true,  // ← enable WebSocket upgrade
      },
      '/v1': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})