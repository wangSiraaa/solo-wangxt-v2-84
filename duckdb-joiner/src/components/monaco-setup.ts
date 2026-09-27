import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// 仅 SQL 编辑，使用基础 editor worker 即可（语法高亮由内置 Monarch tokenizer 提供）
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export { monaco };
