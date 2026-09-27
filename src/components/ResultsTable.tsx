import type { ReactNode } from 'react';
import type { ExecutionOutcome, QueryResultPage } from '../types';
import { displayValue, formatInZone } from '../lib/format';

interface Props {
  outcome: ExecutionOutcome;
  tz: string;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (n: number) => void;
}

export function ResultsTable({ outcome, tz, page, pageSize, onPage, onPageSize }: Props) {
  const p = outcome.page;
  return (
    <>
      <Diagnostics outcome={outcome} />
      <div className="result-header">
        <span className="info">
          共 <strong>{p.totalRows}</strong> 行 · 第 {page + 1}/{p.pageCount} 页 · 耗时 {p.elapsedMs} ms
        </span>
        <span className="spacer" />
        <div className="pager">
          <button disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
          <span className="pages">{page + 1} / {p.pageCount}</span>
          <button disabled={page + 1 >= p.pageCount} onClick={() => onPage(page + 1)}>下一页</button>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {[5, 25, 50, 100, 250].map((n) => <option key={n} value={n}>{n} 行/页</option>)}
          </select>
        </div>
      </div>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {p.columns.map((c, i) => (
                <th key={i}>
                  {c.name}
                  <span className="thtype">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((v, ci) => {
                  const typeName = p.columns[ci].type;
                  const isTs = /Timestamp|Date/.test(typeName);
                  const isNum = /Int|Float|Double|Decimal/.test(typeName);
                  const disp = displayValue(v);
                  let content: ReactNode = disp.text;
                  if (disp.kind === 'null') content = <span className="null">NULL</span>;
                  else if (disp.kind === 'empty') content = <span className="empty">&quot;&quot;</span>;
                  else if (isTs && v instanceof Date) content = formatInZone(v, tz);
                  return (
                    <td
                      key={ci}
                      className={isTs ? 'ts' : isNum ? 'num' : ''}
                      title={disp.kind === 'value' ? disp.text : undefined}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Diagnostics({ outcome }: { outcome: ExecutionOutcome }) {
  const d = outcome.diagnostics;
  if (d.length === 0) return null;
  return (
    <div className="diag-grid">
      {d.map((s, i) => (
        <div className="diag-card" key={i}>
          <div className="title">
            JOIN {s.stepIndex}：{s.leftTable} → {s.rightTable}
            <span className="badge" style={{ marginLeft: 6 }}>{s.joinType.toUpperCase()}</span>
          </div>
          <div className="stat"><span>键</span><span className="v">{s.leftKey} = {s.rightKey}</span></div>
          <div className="stat">
            <span>联结前行数</span><span className="v">{s.leftRowsBefore}</span>
          </div>
          <div className="stat">
            <span>联结后行数</span>
            <span className="v">{s.resultRowsAfter}
              {s.fanoutRows > 0 && <span style={{ color: 'var(--warn)' }}>（扇出 +{s.fanoutRows}）</span>}
            </span>
          </div>
          <div className={`stat ${s.unmatchedLeftKeys > 0 ? 'warn' : 'good'}`}>
            <span>左侧未匹配键</span><span className="v">{s.unmatchedLeftKeys}</span>
          </div>
          <div className={`stat ${s.unmatchedRightKeys > 0 ? 'warn' : 'good'}`}>
            <span>右侧未匹配键</span><span className="v">{s.unmatchedRightKeys}</span>
          </div>
          <div className={`stat ${s.manyToManyKeys > 0 ? 'bad' : 'good'}`}>
            <span>多对多重复键</span><span className="v">{s.manyToManyKeys}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function emptyPage(pageSize: number): QueryResultPage {
  return { columns: [], rows: [], totalRows: 0, pageSize, page: 0, pageCount: 0, elapsedMs: 0 };
}
