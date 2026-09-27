import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // duckdb-wasm 与 monaco 体积较大，放宽 chunk 警告阈值
    chunkSizeWarningLimit: 20000,
  },
});
