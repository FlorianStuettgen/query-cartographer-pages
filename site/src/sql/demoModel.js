export const LARGE_DEMO_SCHEMA = `-- rows: fact_orders=95000000, dim_accounts=640000
-- sensitive: dim_accounts.owner_email

CREATE TABLE fact_orders (
  order_id bigint PRIMARY KEY,
  customer_id bigint NOT NULL,
  account_id bigint NOT NULL,
  event_date timestamp NOT NULL,
  amount numeric NOT NULL
);

CREATE TABLE dim_accounts (
  account_id bigint PRIMARY KEY,
  segment text,
  region text,
  owner_email text
);

CREATE INDEX ON fact_orders(account_id, event_date);
CREATE INDEX ON dim_accounts(region);`;

export function buildLargeDemoSql(stageCount = 115) {
  const blocks = [];
  for (let index = 1; index <= stageCount; index += 1) {
    const current = String(index).padStart(3, "0");
    const previous = String(index - 1).padStart(3, "0");
    const first = index === 1;
    const alias = first ? "fo" : "s";
    const source = first ? "fact_orders fo" : `stage_${previous} s`;
    const periodSource = first ? "event_date" : "period";
    const revenue = first ? "SUM(fo.amount)" : "SUM(s.revenue)";
    const orders = first ? "COUNT(*)" : "SUM(s.order_count)";
    blocks.push([
      `${first ? "WITH" : ","} stage_${current} AS (`,
      "  SELECT",
      `    ${alias}.customer_id,`,
      `    ${alias}.account_id,`,
      `    DATE_TRUNC('month', ${alias}.${periodSource}) AS period,`,
      `    ${revenue} AS revenue,`,
      `    ${orders} AS order_count`,
      `  FROM ${source}`,
      `  LEFT JOIN dim_accounts da_${current} ON da_${current}.account_id = ${alias}.account_id`,
      `  WHERE ${alias}.${periodSource} >= DATE '2024-01-01'`,
      `    AND (da_${current}.segment = 'enterprise' OR da_${current}.region LIKE '%west%')`,
      `  GROUP BY ${alias}.customer_id, ${alias}.account_id, DATE_TRUNC('month', ${alias}.${periodSource})`,
      ")"
    ].join("\n"));
  }

  const last = String(stageCount).padStart(3, "0");
  return `${blocks.join("\n")}
SELECT
  customer_id,
  account_id,
  SUM(revenue) AS total_revenue,
  SUM(order_count) AS modeled_orders,
FROM stage_${last} s
JOIN WHERE s.account_id = da.account_id
WHERE (s.revenue > 0
GROUP BY customer_id, account_id
ORDER BY total_revenue DESC
OFFSET 500;`;
}
