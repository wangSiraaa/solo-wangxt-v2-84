/** Slim Monaco entry: editor API + core services + SQL language only.
 * Avoids pulling TS/CSS/HTML/JSON language workers (~9 MB) we never use.
 */
import * as monaco from 'monaco-esm/editor/editor.api.js';
import 'monaco-esm/languages/definitions/sql/register.js';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor-worker?worker';

let configured = false;

export function setupMonaco(): void {
  if (configured) return;
  configured = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      void label;
      return new EditorWorker();
    },
  };
  // Make @monaco-editor/react use the bundled instance instead of a CDN.
  loader.config({ monaco });
}

export { monaco };
