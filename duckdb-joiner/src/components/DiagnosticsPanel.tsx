import type { Diagnostics, JoinDiag } from '../types';

interface Props {
  diag: Diagnostics | null;
  resultRows: number | null;
}

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

function delta(joined: number | null, left: number | null): string {
  if (joined === null || left === null) return '—';
  const d = joined - left;
  return d >= 0 ? `+${d}` : String(d);
}

function keyKind(j: JoinDiag): { text: string; cls: string } {
  const dl = j.dupLeft ?? 0;
  const dr = j.dupRight ?? 0;
  if (dl > 0 && dr > 0) return { text: '多对多（两侧键均重复）', cls: 'warn' };
  if (dl > 0) return { text: '左侧键重复', cls: 'info' };
  if (dr > 0) return { text: '右侧键重复', cls: 'info' };
  return { text: '两侧键均唯一', cls: 'ok' };
}

function JoinCard({ j }: { j: JoinDiag }) {
  const kind = keyKind(j);
  return (
    <div className="join-card">
      <div className="join-title">
        <span className="join-idx">JOIN #{j.index}</span>
        <code>{j.label}</code>
      </div>
      {!j.certain && j.leftKey && (
        <div className="muted small">⚠ ON 条件键归属不完全确定，以下统计按书写顺序推断</div>
      )}
      {j.error && <div className="error small">诊断查询失败：{j.error}</div>}
      <div className="join-stats">
        <div className="stat">
          <div className="stat-label">行数变化</div>
          <div className="stat-value">
            {fmt(j.leftRows)} → {fmt(j.joinedRows)}{' '}
            <span className={j.joinedRows !== null && j.leftRows !== null && j.joinedRows > j.leftRows ? 'delta-up' : 'delta'}>
              ({delta(j.joinedRows, j.leftRows)})
            </span>
          </div>
          <div className="muted small">右侧输入 {fmt(j.rightRows)} 行</div>
        </div>
        <div className="stat">
          <div className="stat-label">未匹配键（按不同键计数）</div>
          <div className="stat-value">
            左 {fmt(j.unmatchedLeft)} · 右 {fmt(j.unmatchedRight)}
          </div>
          <div className="muted small">NULL 键：左 {fmt(j.nullLeft)} · 右 {fmt(j.nullRight)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">重复键</div>
          <div className="stat-value">
            左 {fmt(j.dupLeft)} · 右 {fmt(j.dupRight)}
          </div>
          <div>
            <span className={`badge ${kind.cls}`}>{kind.text}</span>
          </div>
        </div>
      </div>
      {j.leftKey && j.rightKey && (
        <div className="muted small mono">
          键：{j.leftKey} = {j.rightKey}
        </div>
      )}
    </div>
  );
}

/** 联结诊断面板：行数、未匹配键、多对多扇出 */
export function DiagnosticsPanel({ diag, resultRows }: Props) {
  if (!diag) return null;
  return (
    <div className="diag">
      <h3>联结诊断</h3>
      {resultRows !== null && (
        <div className="diag-summary">
          查询结果共 <strong>{resultRows}</strong> 行
        </div>
      )}
      {!diag.parsed && <div className="muted">未能解析 JOIN 结构，跳过诊断：{diag.reason}</div>}
      {diag.parsed && diag.joins.length === 0 && (
        <div className="muted">{diag.reason ?? '无 JOIN'}</div>
      )}
      {diag.joins.map((j) => (
        <JoinCard key={j.index} j={j} />
      ))}
    </div>
  );
}
