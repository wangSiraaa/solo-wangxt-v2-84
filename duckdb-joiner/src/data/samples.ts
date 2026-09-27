import customersCsv from './samples/customers.csv?raw';
import ordersCsv from './samples/orders.csv?raw';
import promotionsCsv from './samples/promotions.csv?raw';
import eventsCsv from './samples/events.csv?raw';

/** 内置示例数据：含前导零编号、重复键、时区时间戳、空串/NULL 对比 */
export const SAMPLE_FILES: { name: string; content: string }[] = [
  { name: 'customers.csv', content: customersCsv },
  { name: 'orders.csv', content: ordersCsv },
  { name: 'promotions.csv', content: promotionsCsv },
  { name: 'events.csv', content: eventsCsv },
];

export interface QueryExample {
  id: string;
  title: string;
  note: string;
  sql: string;
}

export const EXAMPLES: QueryExample[] = [
  {
    id: 'select',
    title: '选择列',
    note: '最基本的列选择',
    sql: `SELECT order_id, customer_id, amount
FROM orders
ORDER BY order_id;`,
  },
  {
    id: 'filter',
    title: '条件过滤',
    note: '数值比较 + 时区时间戳过滤',
    sql: `SELECT *
FROM orders
WHERE amount >= 100
  AND order_ts >= TIMESTAMPTZ '2026-09-21 00:00:00+00:00'
ORDER BY order_ts;`,
  },
  {
    id: 'join1',
    title: '单个 JOIN',
    note: 'orders ⋈ customers；观察未匹配键诊断',
    sql: `SELECT o.order_id, o.customer_id, c.name, o.amount
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
ORDER BY o.order_id;`,
  },
  {
    id: 'join2',
    title: '多个 JOIN（含多对多）',
    note: '再联结 promotions，观察多对多造成的行数放大',
    sql: `SELECT o.order_id, c.name, p.label AS promo, o.amount
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
JOIN promotions p ON o.customer_id = p.customer_id
ORDER BY o.order_id, p.promo_id;`,
  },
  {
    id: 'tz',
    title: '时区时间列',
    note: 'TIMESTAMPTZ 在不同时区下的显示',
    sql: `SELECT event_id,
       happened_at,
       happened_at AT TIME ZONE 'Asia/Shanghai' AS shanghai_time,
       happened_at AT TIME ZONE 'UTC' AS utc_time
FROM events
ORDER BY happened_at;`,
  },
  {
    id: 'nulls',
    title: '空字符串 vs NULL',
    note: '区分"填写了空串"与"未填写"',
    sql: `SELECT customer_id, name, email,
       email IS NULL AS email_is_null,
       email = ''    AS email_is_empty
FROM customers
ORDER BY customer_id;`,
  },
];
