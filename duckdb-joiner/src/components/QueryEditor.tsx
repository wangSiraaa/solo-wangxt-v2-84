import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  height?: number;
}

/** Monaco SQL 编辑器；Ctrl/Cmd+Enter 执行 */
export function QueryEditor({ value, onChange, onRun, height = 220 }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onRunRef = useRef(onRun);
  const lastEmitted = useRef(value);
  onRunRef.current = onRun;

  useEffect(() => {
    if (!divRef.current) return;
    const editor = monaco.editor.create(divRef.current, {
      value,
      language: 'sql',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      padding: { top: 8, bottom: 8 },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current());
    editor.onDidChangeModelContent(() => {
      const v = editor.getValue();
      lastEmitted.current = v;
      onChange(v);
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部（示例插入 / 刷新恢复）更新内容
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== lastEmitted.current) {
      lastEmitted.current = value;
      editor.setValue(value);
    }
  }, [value]);

  return <div ref={divRef} style={{ height }} className="editor-box" />;
}
