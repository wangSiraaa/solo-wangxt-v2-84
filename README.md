# 本地数据研究助理（纯浏览器，无后端）

在浏览器内联结本地 **CSV / Parquet** 文件并用 SQL 做研究分析的单页应用。
数据全程不出本机：没有后端接口、没有网络上传。

- **React 18 + TypeScript + Vite**：文件列表、查询编辑、结果表
- **DuckDB-Wasm**：在浏览器进程内执行 SQL（包括多表 JOIN）
- **Monaco**：本地打包的 SQL 编辑器（不走 CDN）
- **OPFS**（Origin Private File System）：导入文件字节的持久工作副本
- **IndexedDB**：只存工程元数据（文件描述、列设置、查询定义）

## 运行

```bash
npm install
npm run make-samples   # 生成 public/samples 下的三个样例（已自带，可重复生成）
npm run dev            # 开发服务器
# 或
npm run build && npm run preview
```

打开后从左侧「内置样例」一键载入，或用「导入 CSV / Parquet」选择本地文件。

## 数据如何流动（隐私）

1. 选择本地文件后，字节在页内被读取并写入浏览器的 **OPFS**；没有任何网络发送。
2. 导入时 DuckDB 从 OPFS 副本把数据**物化**为内存表，随后立即释放 OPFS 文件句柄
   （避免多句柄长期占用导致的锁问题）。
3. 查询只针对这些内存表执行。
4. **刷新页面**后：IndexedDB 中的查询定义、列设置会恢复，应用会再次从 OPFS 副本重建内存表。
   浏览器**不会**也无法在未再次授权的情况下重新读取磁盘上的原始文件；若 OPFS 副本
   已被浏览器清理，界面会提示重新导入。

> OPFS 与 IndexedDB 都是按源（origin）隔离的浏览器私有存储，其他网站无法访问。

## 列类型与空值语义

- 导入后显示每个文件的**列名和推断类型**（VARCHAR / INTEGER / BIGINT / DOUBLE /
  BOOLEAN / DATE / TIMESTAMP / TIMESTAMPTZ）。
- 每列可在左侧卡片里手动改类型。把编号列设为 **VARCHAR** 即可保留前导零
  （样例中的 `subject_id=001`、`zip=00450`）。
- **空字符串 `''` 与空值 NULL 严格区分**：
  - 导入 CSV 时做一次流式改写——未加引号的空单元格替换为每文件唯一的 NULL 哨兵，
    以 `nullstr` 读成 NULL；带引号的 `""` 原样保留为空字符串。
  - 结果表里 NULL 显示为斜体 `NULL`，空串显示为 `""`；
    用 `col IS NULL` 判空值、`col = ''` 判空字符串。

## 查询

提供构建器和 SQL 两种模式（互相生成）。工具栏「插入示例」包含：

- 选择 + 区分空串 / NULL
- 过滤（前导零、非空非空串）
- 一个 LEFT JOIN（看未匹配键）
- 多个 JOIN（受试者 → 就诊 → 化验）
- 时区时间列按 `Asia/Shanghai` 显示

JOIN 全部以链式 CTE（`t0, t1, …`）表达，键始终带表名限定，因此多步 JOIN 不会因
重名列出错。

### JOIN 诊断

执行构建器中的 JOIN 查询后，每一步显示一张诊断卡：

| 指标 | 含义 |
| --- | --- |
| 联结前行数 → 联结后行数 | 行数如何变化 |
| 左侧 / 右侧未匹配键数 | 孤儿键、漏配键（NULL 键不计入） |
| 多对多重复键数 | 两边都重复、真正形成 m:m 的键个数 |
| 扇出行数 | 相比 1:1 因重复键多产生的行数（`Σ lc·rc − lc`） |

结果区还显示总行数、耗时，支持分页（5/25/50/100/250 行/页）和
**导出 CSV（导出的是完整结果，不是当前页）**。导出沿用空值约定：NULL 为裸空单元格、
空字符串为带引号的 `""`。

## 样例数据与校验

`npm run make-samples`（`scripts/gen_samples.cjs`，用同一份 DuckDB-Wasm 的 Node
绑定生成，无需 Python）产出三个文件，刻意埋入边界情况：

- `subjects.csv`：前导零编号、`TIMESTAMPTZ` 列、`""`（空串）与未引用空（NULL）、
  一个重复键 `002`。
- `visits.csv`：孤儿键 `S-999`、无匹配的 `003`、`002` 重复、空 score 为 NULL。
- `labs.parquet`：Snappy 压缩的 Parquet，`TIMESTAMPTZ` 列、重复 `visit_id=V2`
  （与重复的 `002` 构成真·多对多）、孤儿 `V9`、comment 列含 `''` 与 NULL。

期望的诊断结果（已被自动化端到端测试断言）：

- 第一步 subjects LEFT JOIN visits：7 行 → 9 行，左/右未匹配键各 1，
  多对多键 1，扇出 +2。
- 第二步再 INNER JOIN labs：9 → 10 行，多对多键 1，扇出 +3。
- `drawn_at` 是带时区时刻，UTC 01:20 在上海时间显示为 09:20（+08:00）。

`scripts/verify_semantics.cjs` 用 Node 绑定验证类型嗅探、空串/NULL、视图强转与
诊断 SQL 的语义。

## 端到端测试

`tests/e2e.mjs` 用 Playwright + 真实 DuckDB-Wasm 在无头 Chromium 中覆盖上述全部验收
场景（导入、类型、空值、JOIN 诊断、分页、导出、时区、刷新恢复）。需要本地 Chromium：

```bash
npx playwright install chromium
npm run build && npm run preview   # 监听 :4173
node tests/e2e.mjs
```

## 目录

```
src/
  lib/
    duckdb.ts        DuckDB-Wasm 生命周期、OPFS 句柄、建表 SQL、查询与 JOIN 诊断
    csv.ts           CSV 流式解析 / 类型嗅探 / NULL 哨兵改写
    opfs.ts          OPFS 异步读写
    idb.ts           IndexedDB 元数据持久化
    importService.ts 导入流水线（本地文件 → OPFS → 内存表）
    query.ts         构建器 → CTE 链 SQL、分页包装
    format.ts        时区格式化、网格显示、CSV 导出
    monacoSetup.ts   本地 Monaco worker + SQL 语言
  components/        FilePanel / QueryBuilder / ResultsTable
  hooks/useProject.ts 元数据状态与持久化
  App.tsx            编排、执行、分页、刷新恢复
scripts/             样例生成与语义校验
tests/e2e.mjs        Playwright 端到端验收
```

## 说明与取舍

- 使用 DuckDB-Wasm 的 EH（异常处理）构建，因此**不需要** COOP/COEP 跨源隔离头。
- 大文件：CSV 导入的 NULL 改写是分块流式的；但最终内存表受浏览器内存约束，适合
  研究规模的数据集（百万行级），不是数仓规模分析引擎。
- DuckDB-Wasm 在该无头环境读取**未压缩 Parquet** 会异常缓慢，样例因此使用 Snappy
  压缩（真实 Parquet 默认也压缩）。
