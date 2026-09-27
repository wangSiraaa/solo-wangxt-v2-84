import type { ArrowTable } from './duckdb';
import type { Cell, ResultGrid } from '../types';

/**
 * 把 Arrow 结果转成表格单元格。
 * 重点：
 *  - NULL 与空字符串是两种不同的单元格（kind: 'null' / 'empty'）
 *  - 时间戳按 Arrow 类型元数据（单位、时区）格式化
 *  - DECIMAL(128 位) 用 BigInt 还原，避免精度丢失
 */

// Arrow Type 枚举（避免直接依赖 apache-arrow 版本）
const TYPE = {
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  FixedSizeBinary: 15,
  Map: 17,
} as const;

interface ArrowTypeLike {
  typeId: number;
  unit?: number;
  timezone?: string | null;
  scale?: number;
  precision?: number;
  toString(): string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatUtcDateTime(ms: number, withZone: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const s =
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return withZone ? `${s} UTC` : s;
}

/** unit: 0=s 1=ms 2=us 3=ns → 毫秒因子 */
const TS_FACTOR = [1e3, 1, 1e-3, 1e-6];

function formatTimestamp(value: number | bigint, type: ArrowTypeLike): string {
  const unit = type.unit ?? 2;
  const factor = TS_FACTOR[unit] ?? 1e-3;
  const ms = typeof value === 'bigint' ? Number(value) * factor : value * factor;
  return formatUtcDateTime(ms, !!type.timezone);
}

function formatDate(value: unknown, type: ArrowTypeLike): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const days = Number(value);
  // DateUnit: 0=DAY 1=MILLISECOND
  const ms = type.unit === 1 ? days : days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function formatTime(value: number | bigint, type: ArrowTypeLike): string {
  const unit = type.unit ?? 2;
  const factor = TS_FACTOR[unit] ?? 1e-3;
  let ms = typeof value === 'bigint' ? Number(value) * factor : value * factor;
  ms = ((ms % 86400000) + 86400000) % 86400000;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Arrow Decimal：小端 128/256 位二进制 → 十进制字符串 */
function formatDecimal(bytes: Uint8Array, scale: number): string {
  if (bytes.length === 0) return '0';
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  if (bytes[bytes.length - 1] & 0x80) {
    v -= 1n << BigInt(bytes.length * 8);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const digits = v.toString().padStart(scale + 1, '0');
  const out = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return neg ? `-${out}` : out;
}

function toCell(value: unknown, type: ArrowTypeLike): Cell {
  if (value === null || value === undefined) return { kind: 'null' };

  switch (type.typeId) {
    case TYPE.Utf8: {
      const s = String(value);
      return s === '' ? { kind: 'empty' } : { kind: 'value', text: s };
    }
    case TYPE.Bool:
      return { kind: 'value', text: value ? 'true' : 'false' };
    case TYPE.Int:
    case TYPE.Float:
      return { kind: 'value', text: String(value) };
    case TYPE.Decimal: {
      if (value instanceof Uint8Array) {
        return { kind: 'value', text: formatDecimal(value, type.scale ?? 0) };
      }
      return { kind: 'value', text: String(value) };
    }
    case TYPE.Timestamp:
      return { kind: 'value', text: formatTimestamp(value as number | bigint, type) };
    case TYPE.Date:
      return { kind: 'value', text: formatDate(value, type) };
    case TYPE.Time:
      return { kind: 'value', text: formatTime(value as number | bigint, type) };
    case TYPE.Binary:
    case TYPE.FixedSizeBinary: {
      if (value instanceof Uint8Array) {
        const hex = Array.from(value.slice(0, 16))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return { kind: 'value', text: value.length > 16 ? `${hex}…` : hex };
      }
      return { kind: 'value', text: String(value) };
    }
    default: {
      // List / Struct / Map 等复合类型
      if (typeof value === 'object' && value !== null) {
        try {
          return { kind: 'value', text: JSON.stringify(value) };
        } catch {
          return { kind: 'value', text: String(value) };
        }
      }
      return { kind: 'value', text: String(value) };
    }
  }
}

export function shortType(type: ArrowTypeLike): string {
  try {
    return type.toString();
  } catch {
    return `type#${type.typeId}`;
  }
}

export function tableToGrid(table: ArrowTable): ResultGrid {
  const fields = table.schema.fields;
  const columns = fields.map((f) => ({
    name: f.name,
    type: shortType(f.type as unknown as ArrowTypeLike),
  }));
  const children = fields.map((_, i) => table.getChildAt(i));
  const rows: Cell[][] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < children.length; c++) {
      row.push(toCell(children[c]?.get(r), fields[c].type as unknown as ArrowTypeLike));
    }
    rows.push(row);
  }
  return { columns, rows };
}
