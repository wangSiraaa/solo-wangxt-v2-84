# 本地数据联结工作台（duckdb-joiner）

面向研究场景的纯浏览器数据联结工具：在本地联结 CSV 与 Parquet 文件，**数据不离开浏览器，无任何后端接口**。

## 功能

- **文件导入**：本地 CSV / Parquet，经 `<input type=file>` 读入，不经过任何服务器
- **模式展示**：导入后显示每个文件的列名与 DuckDB 推断类型
- **列类型覆盖**：可把编号列设为 `VARCHAR` 保留前导零（如 `001`）；CSV 用 `read_csv` 的
  `types={...}` 覆盖，Parquet 用 `CAST` 覆盖；覆盖后立即重建视图并校验
- **空串 / 空值区分**：导入时设置 `allow_quoted_nulls=false`，未加引号的空字段 → `NULL`，
  引号包围的 `""` → 空字符串；结果表中两者用不同徽标渲染
- **查询编辑器**：Monaco（SQL 高亮），Ctrl/Cmd+Enter 执行；内置选择、过滤、单 JOIN、
  多 JOIN（多对多）、时区、空值 6 个示例
- **联结诊断**：执行后逐 JOIN 显示
  - 行数变化（左输入 → 联结后，多对多扇出 / 未匹配丢失一目了然）
  - 左右两侧未匹配键数量、NULL 键数量、重复键数量
  - 键唯一性分类（两侧唯一 / 左侧重复 / 右侧重复 / 多对多）
- **结果分页**：结果物化为临时表后 `LIMIT/OFFSET` 分页（50/100/500 行每页）
- **导出 CSV**：`COPY TO` 导出当前结果（`NULL` 导出为字面量 `NULL`，与空串区分）
- **持久化**：
  - 文件字节 → **OPFS**（`research-joiner/` 目录），DuckDB 通过 `opfs://` URL 直连读取
    （不可用时退回内存缓冲）
  - 工程元数据（文件清单、列类型覆盖、查询定义、已保存查询）→ **IndexedDB**
  - 刷新后恢复查询定义与文件副本

## 隐私边界（重要）

- 刷新后恢复的是**导入时存入 OPFS 的副本**，不是你磁盘上的原始文件。
  浏览器**无法**在未重新授权的情况下读取磁盘原件；若磁盘文件有更新，请点击文件卡片上的
  「重新选择文件」手动同步。
- 清除浏览器站点数据会同时删除 OPFS 副本与 IndexedDB 元数据。

## 技术栈

React 18 + TypeScript + Vite · DuckDB-Wasm（SQL 执行）· Monaco（编辑器）·
OPFS（工作文件）· IndexedDB（元数据）

## 开发

```bash
npm install
npm run dev          # 开发服务器
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览构建产物
```

## 验证

```bash
npm run verify:sql   # 用原生 DuckDB 验证全部 SQL 逻辑（28 项断言）
node scripts/e2e.mjs # 真实 Chromium 端到端冒烟测试（需先 npm run preview）
```

`verify:sql` 覆盖：类型推断与覆盖、空串/NULL 区分、TIMESTAMPTZ 推断、
联结诊断查询（未匹配键 / 重复键 / 多对多扇出）、AT TIME ZONE、COPY 导出、分页。

## 内置示例数据

| 表 | 说明 |
| --- | --- |
| `customers` | 5 行；`customer_id` 带前导零；`email` 同时含空字符串（002）与 NULL（003） |
| `orders` | 7 行；`customer_id` 有重复键（001/002/003 各两单）与未匹配键（009）；`order_ts` 为带时区时间戳 |
| `promotions` | 6 行；`customer_id` 有重复键（001、004），与 `orders` 构成多对多 |
| `events` | 4 行；`happened_at` 混合 `+08:00 / +00:00 / -08:00` 偏移；`note` 含空串与 NULL |

## 已知限制

- 联结诊断的 SQL 解析支持 `FROM t a JOIN u b ON a.k = b.k` 链式结构与单等值键；
  子查询作为基表、`USING`、复合键会跳过诊断并明确提示，不影响查询执行
- 诊断中的行数统计按 FROM/JOIN 链前缀计算，未计入 `WHERE` 过滤
- 导出的 CSV 中字面量 `NULL` 与内容为 "NULL" 的字符串无法区分（NULLSTR 方案的固有取舍）
