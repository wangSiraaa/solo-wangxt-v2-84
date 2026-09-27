import { useRef, useState } from 'react';
import type { ColumnType, FileMeta } from '../types';
import { opfsExists } from '../lib/opfs';
import { fetchSample, importFile } from '../lib/importService';
import type { DuckEngine } from '../lib/duckdb';
import { formatBytes } from '../lib/text';

const TYPES: ColumnType[] = [
  'VARCHAR', 'BIGINT', 'INTEGER', 'DOUBLE', 'BOOLEAN',
  'DATE', 'TIMESTAMP', 'TIMESTAMPTZ',
];

const SAMPLES: { file: string; label: string }[] = [
  { file: 'subjects.csv', label: 'subjects.csv（受试者，含前导零/空串/重复键/时区列）' },
  { file: 'visits.csv', label: 'visits.csv（就诊，含孤儿键/重复键/NULL）' },
  { file: 'labs.parquet', label: 'labs.parquet（化验，Parquet + TIMESTAMPTZ + 重复键）' },
];

interface Props {
  engine: DuckEngine;
  files: FileMeta[];
  activeFileId: string | null;
  onSelect: (id: string | null) => void;
  onImported: (meta: FileMeta) => void;
  onTypeChange: (fileId: string, columnName: string, type: ColumnType) => void;
  onRemove: (id: string) => void;
}

export function FilePanel({
  engine, files, activeFileId, onSelect, onImported, onTypeChange, onRemove,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const taken = new Set(files.map((f) => f.tableName));
    for (const file of Array.from(list)) {
      const kind = /\.parquet$/i.test(file.name) ? 'parquet' : 'csv';
      setBusy(file.name);
      try {
        const { meta } = await importFile({ kind, file, isSample: false }, taken, engine);
        onImported(meta);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  async function loadSample(name: string) {
    setError(null);
    setBusy(name);
    try {
      const kind = name.endsWith('.parquet') ? 'parquet' : 'csv';
      const file = await fetchSample(name);
      const taken = new Set(files.map((f) => f.tableName));
      const { meta } = await importFile({ kind, file, isSample: true }, taken, engine);
      onImported(meta);
    } catch (e) {
      setError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="sidebar">
      <div className="section-title">本地文件（OPFS 工作副本）</div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={!!busy}>
          {busy ? `导入中：${busy}…` : '导入 CSV / Parquet'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.parquet"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        文件字节经流式处理后写入浏览器 OPFS，全程不上传。刷新后保留的是 OPFS
        中的副本与查询定义；浏览器不会自行重新读取磁盘上的原文件。
      </div>

      <div className="section-title">内置样例</div>
      <div className="samples-row">
        {SAMPLES.map((s) => (
          <button key={s.file} className="ghost" onClick={() => loadSample(s.file)} disabled={!!busy}>
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="section-title">已导入（{files.length}）</div>
      {files.length === 0 && <div className="hint">尚未导入文件。</div>}
      {files.map((f) => (
        <FileCard
          key={f.id}
          file={f}
          expanded={activeFileId === f.id}
          onToggle={() => onSelect(activeFileId === f.id ? null : f.id)}
          onTypeChange={(col, t) => onTypeChange(f.id, col, t)}
          onRemove={() => onRemove(f.id)}
        />
      ))}
    </aside>
  );
}

function FileCard({
  file, expanded, onToggle, onTypeChange, onRemove,
}: {
  file: FileMeta;
  expanded: boolean;
  onToggle: () => void;
  onTypeChange: (columnName: string, type: ColumnType) => void;
  onRemove: () => void;
}) {
  const [missing, setMissing] = useState<boolean | null>(null);
  if (missing === null) void opfsExists(file.opfsPath).then(setMissing);

  return (
    <div className={`file-card ${expanded ? 'active' : ''}`} onClick={onToggle}>
      <div className="row1">
        <span className="tname">
          <code className="k">{file.tableName}</code>
        </span>
        <span className={`badge ${file.kind}`}>{file.kind.toUpperCase()}</span>
        {file.isSample && <span className="badge sample">样例</span>}
      </div>
      <div className="fname">{file.fileName}</div>
      <div className="meta">
        {formatBytes(file.size)} · {file.columns.length} 列
        {missing === false && <span style={{ color: 'var(--danger)' }}> · OPFS 副本缺失</span>}
      </div>
      {expanded && (
        <div className="col-list" onClick={(e) => e.stopPropagation()}>
          {file.columns.map((c) => (
            <div className="col-row" key={c.name}>
              <span className="cname" title={c.name}>{c.name}</span>
              <select
                value={c.type}
                onChange={(e) => onTypeChange(c.name, e.target.value as ColumnType)}
                title={
                  c.type === c.inferredType
                    ? `推断类型：${c.inferredType}`
                    : `推断为 ${c.inferredType}，已手动覆盖`
                }
              >
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {c.type !== c.inferredType && <span className="type-chip overridden">覆盖</span>}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="danger ghost" onClick={onRemove}>删除文件</button>
          </div>
        </div>
      )}
    </div>
  );
}
