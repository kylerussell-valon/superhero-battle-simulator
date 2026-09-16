import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5177,
    strictPort: true,
    host: '127.0.0.1',
  },
})
