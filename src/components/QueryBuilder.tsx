import { useEffect, useMemo, useState } from 'react';
import type { FileMeta, JoinStep, JoinType, QueryDef } from '../types';
import { qIdent } from '../lib/duckdb';

interface Props {
  query: QueryDef;
  files: FileMeta[];
  onChange: (merged: QueryDef) => void;
  onGeneratedSql: () => void;
}

const JOIN_TYPES: JoinType[] = ['inner', 'left', 'right', 'full'];

function columnsOf(files: FileMeta[], tableName: string): string[] {
  return files.find((f) => f.tableName === tableName)?.columns.map((c) => c.name) ?? [];
}

let joinSeq = 0;
function makeJoin(files: FileMeta[], baseTable: string, joins: JoinStep[]): JoinStep {
  const used = new Set([baseTable, ...joins.map((j) => j.rightTable)]);
  const rightTable = files.map((f) => f.tableName).find((t) => !used.has(t)) ?? files[1]?.tableName ?? baseTable;
  const leftTable = joins.length === 0 ? baseTable : joins[joins.length - 1].rightTable;
  const leftCols = columnsOf(files, leftTable);
  const rightCols = columnsOf(files, rightTable);
  joinSeq++;
  return {
    id: `j-${Date.now().toString(36)}-${joinSeq}`,
    rightTable,
    joinType: 'left',
    leftKey: leftCols[0] ?? '',
    rightKey: rightCols[0] ?? '',
  };
}

/**
 * Builder edits are accumulated in local draft state so a burst of changes
 * (test automation or fast typing) cannot overwrite each other with a stale
 * prop; the merged query definition is committed upward on every change.
 */
export function QueryBuilder({ query, files, onChange, onGeneratedSql }: Props) {
  const [draft, setDraft] = useState<QueryDef>(query);

  useEffect(() => { setDraft(query); }, [query.id]);

  const baseCols = useMemo(() => columnsOf(files, draft.tableName), [files, draft.tableName]);

  function commit(patch: Partial<QueryDef>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      onChange(next);
      return next;
    });
  }

  function patchJoin(id: string, patch: Partial<JoinStep>) {
    const joins = draft.joins.map((j) => {
      if (j.id !== id) return j;
      const next = { ...j, ...patch };
      if (patch.rightTable) {
        const rightCols = columnsOf(files, next.rightTable);
        next.rightKey = rightCols.includes(j.rightKey) ? j.rightKey : rightCols[0] ?? '';
      }
      return next;
    });
    commit({ joins });
  }

  function addJoin() {
    commit({ joins: [...draft.joins, makeJoin(files, draft.tableName, draft.joins)] });
  }

  function removeJoin(id: string) {
    commit({ joins: draft.joins.filter((j) => j.id !== id) });
  }

  return (
    <div className="builder">
      <div className="builder-row">
        <label>基础表</label>
        <select
          value={draft.tableName}
          onChange={(e) => commit({ tableName: e.target.value, joins: [] })}
        >
          {files.map((f) => (
            <option key={f.id} value={f.tableName}>
              {f.tableName} ({f.fileName})
            </option>
          ))}
        </select>
        <button onClick={addJoin} disabled={files.length < 2}>＋ 添加 JOIN</button>
        <button className="ghost" onClick={onGeneratedSql}>在编辑器中生成 SQL</button>
      </div>

      {draft.joins.map((j, idx) => {
        const leftTable = idx === 0 ? draft.tableName : draft.joins[idx - 1].rightTable;
        const leftCols = columnsOf(files, leftTable);
        const rightCols = columnsOf(files, j.rightTable);
        return (
          <div className="join-card" key={j.id}>
            <div className="jr">
              <strong>JOIN {idx + 1}</strong>
              <select
                data-key="jointype"
                value={j.joinType}
                onChange={(e) => patchJoin(j.id, { joinType: e.target.value as JoinType })}
              >
                {JOIN_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
              </select>
              <label>右表</label>
              <select
                data-key="righttable"
                value={j.rightTable}
                onChange={(e) => patchJoin(j.id, { rightTable: e.target.value })}
              >
                {files.map((f) => <option key={f.id} value={f.tableName}>{f.tableName}</option>)}
              </select>
              <label>ON</label>
              <select
                data-key="leftkey"
                value={j.leftKey}
                onChange={(e) => patchJoin(j.id, { leftKey: e.target.value })}
              >
                {(leftCols.includes(j.leftKey) ? leftCols : [...leftCols, j.leftKey]).map((c) => (
                  <option key={c} value={c}>{qIdent(c)}</option>
                ))}
              </select>
              <span>=</span>
              <select
                data-key="rightkey"
                value={j.rightKey}
                onChange={(e) => patchJoin(j.id, { rightKey: e.target.value })}
              >
                {(rightCols.includes(j.rightKey) ? rightCols : [...rightCols, j.rightKey]).map((c) => (
                  <option key={c} value={c}>{qIdent(c)}</option>
                ))}
              </select>
              <button className="danger ghost" onClick={() => removeJoin(j.id)}>移除</button>
            </div>
          </div>
        );
      })}

      <div className="builder-row">
        <label>WHERE</label>
        <input
          style={{ flex: 1, minWidth: 260 }}
          placeholder={`例如 ${qIdent(baseCols[0] ?? 'col')} IS NOT NULL`}
          value={draft.where}
          onChange={(e) => commit({ where: e.target.value })}
        />
      </div>
      <div className="builder-row">
        <label>ORDER BY</label>
        <input
          style={{ width: 220 }}
          placeholder="例如 1 DESC"
          value={draft.orderBy}
          onChange={(e) => commit({ orderBy: e.target.value })}
        />
        <label>LIMIT</label>
        <input
          type="number"
          value={draft.limit ?? ''}
          placeholder="无"
          onChange={(e) => commit({ limit: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
