import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const monacoRoot = new URL('./node_modules/monaco-editor/esm/vs/', import.meta.url).pathname;
const monacoWorker = `${monacoRoot}/editor/editor.worker.js`;

// DuckDB-Wasm EH (exception-handling) build runs without cross-origin isolation,
// so the app does not require COOP/COEP headers and no data crosses origins.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // monaco's package exports don't map its deep ESM paths; rewrite our
      // own prefix straight to disk (everything stays local, never a CDN).
      { find: /^monaco-esm\/(.*)$/, replacement: `${monacoRoot}/$1` },
      {
        find: /^monaco-editor-worker(\?worker)?$/,
        replacement: `${monacoWorker}?worker`,
      },
    ],
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
});
