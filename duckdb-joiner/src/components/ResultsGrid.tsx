import type { ResultGrid } from '../types';

interface Props {
  grid: ResultGrid;
  totalRows: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}

/** 结果表：分页显示；NULL 与空字符串用不同样式区分 */
export function ResultsGrid({ grid, totalRows, page, pageSize, onPage, onPageSize }: Props) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const start = totalRows === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(totalRows, (page + 1) * pageSize);

  return (
    <div className="results">
      <div className="legend muted small">
        图例：<span className="cell-null">NULL</span> 空值（未填写） ·{' '}
        <span className="cell-empty">&quot;&quot;</span> 空字符串
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {grid.columns.map((c) => (
                <th key={c.name}>
                  <div className="col-name">{c.name}</div>
                  <div className="col-type">{c.type}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="rownum">{page * pageSize + ri + 1}</td>
                {row.map((cell, ci) => {
                  if (cell.kind === 'null') {
                    return (
                      <td key={ci}>
                        <span className="cell-null">NULL</span>
                      </td>
                    );
                  }
                  if (cell.kind === 'empty') {
                    return (
                      <td key={ci}>
                        <span className="cell-empty">&quot;&quot;</span>
                      </td>
                    );
                  }
                  return <td key={ci}>{cell.text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span className="muted">
          第 {start}–{end} 行 / 共 {totalRows} 行
        </span>
        <span className="spacer" />
        <label>
          每页{' '}
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {[50, 100, 500].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button disabled={page <= 0} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <span>
          {page + 1} / {totalPages}
        </span>
        <button disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
