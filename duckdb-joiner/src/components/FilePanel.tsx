import type { FileState } from '../types';
import { OVERRIDE_TYPES } from '../lib/importer';

interface Props {
  files: FileState[];
  busy: boolean;
  onOverride: (fileId: string, column: string, type: string | null) => void;
  onRemove: (fileId: string) => void;
  onReimport: (fileId: string) => void;
}

function statusBadge(f: FileState) {
  switch (f.status) {
    case 'ready':
      return <span className="badge ok">已导入</span>;
    case 'restored':
      return <span className="badge ok">已从 OPFS 恢复</span>;
    case 'missing':
      return <span className="badge warn">副本缺失 · 需重新选择文件</span>;
  }
}

/** 左侧文件面板：文件清单 + 每列的推断类型与覆盖设置 */
export function FilePanel({ files, busy, onOverride, onRemove, onReimport }: Props) {
  if (files.length === 0) {
    return (
      <div className="panel">
        <h2>数据文件</h2>
        <p className="muted">
          尚未导入文件。点击上方「导入文件」选择本地 CSV / Parquet，
          或点击「载入示例数据」。文件只在浏览器内处理，不会上传。
        </p>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>数据文件（{files.length}）</h2>
      {files.map((f) => (
        <div key={f.id} className="file-card">
          <div className="file-head">
            <div>
              <div className="file-name">{f.name}</div>
              <div className="muted small">
                视图 <code>{f.viewName}</code> · {f.kind.toUpperCase()} · {f.rowCount} 行
                {f.mode ? ` · ${f.mode === 'opfs' ? 'OPFS 直连' : '内存缓冲'}` : ''}
              </div>
              <div className="file-status">{statusBadge(f)}</div>
            </div>
            <div className="file-actions">
              {f.status === 'missing' && (
                <button disabled={busy} onClick={() => onReimport(f.id)}>
                  重新选择文件
                </button>
              )}
              <button disabled={busy} className="danger" onClick={() => onRemove(f.id)}>
                移除
              </button>
            </div>
          </div>
          {f.status !== 'missing' && (
            <table className="cols">
              <thead>
                <tr>
                  <th>列名</th>
                  <th>推断类型</th>
                  <th>设为</th>
                  <th>生效类型</th>
                </tr>
              </thead>
              <tbody>
                {f.columns.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td>
                      <span className="type-badge">{c.inferredType}</span>
                    </td>
                    <td>
                      <select
                        disabled={busy}
                        value={c.override ?? ''}
                        onChange={(e) => onOverride(f.id, c.name, e.target.value || null)}
                      >
                        <option value="">自动</option>
                        {OVERRIDE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`type-badge ${c.override ? 'overridden' : ''}`}>
                        {c.effectiveType}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      <p className="muted small">
        提示：DuckDB 嗅探到带前导零的编号（如 <code>001</code>）会自动按文本处理；
        若编号列被推断为数值（或 Parquet 中为整型），在此设为 <code>VARCHAR</code>{' '}
        可避免前导零丢失、便于与外部系统匹配。本工具导入 CSV 时设置{' '}
        <code>allow_quoted_nulls=false</code>：未加引号的空字段读为 <code>NULL</code>，
        引号包围的 <code>&quot;&quot;</code> 读为空字符串。
        若 JOIN 两侧键列类型不一致，DuckDB 会做隐式转换，建议两侧设为相同类型。
      </p>
    </div>
  );
}
