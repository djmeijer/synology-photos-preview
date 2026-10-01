import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:4177', changeOrigin: true } } },
  build: { outDir: 'dist' }
});
