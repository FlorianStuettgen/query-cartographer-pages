import { lookupTable, sourceStats } from "./schema.js";

const MAX_ESTIMATE = 999_999_999_999;

export function buildFlow(ast, schema, diagnosis) {
  if (ast.unsupported || !ast.sql?.trim()) {
    return {
      steps: [],
      maxRows: 0,
      finalRows: 0,
      blastRadius: 0,
      complexity: 0
    };
  }

  const steps = [];
  const stats = sourceStats(ast, schema);
  const base = stats[0];
  let rows = clampRows(base?.rows ?? 10000);
  const initialRows = rows;

  if (base) {
    steps.push(step({
      phase: "from",
      label: base.source.displayName || base.source.name,
      beforeRows: 0,
      afterRows: rows,
      risk: sourceRisk(rows),
      detail: `Seed relation using ${formatRows(rows)} estimated rows.`
    }));
  }

  for (const join of ast.joins) {
    const stat = stats.find((entry) => entry.source === join.source) ?? {
      source: join.source,
      table: lookupTable(schema, join.source.name),
      rows: 10000
    };
    const before = rows;
    const joinedRows = clampRows(stat.rows);
    rows = estimateJoinRows(rows, joinedRows, join, stat.table);

    steps.push(step({
      phase: "join",
      label: `${join.type.toUpperCase()} ${join.source.displayName || join.source.name}`,
      beforeRows: before,
      afterRows: rows,
      risk: joinRisk(before, rows, join),
      evidence: join.condition,
      detail: join.condition
        ? `Adds ${formatRows(joinedRows)} candidate rows through ${join.condition}.`
        : `Adds ${formatRows(joinedRows)} candidate rows without a visible predicate.`
    }));
  }

  for (const predicate of ast.predicates) {
    const before = rows;
    const selectivity = estimatePredicateSelectivity(predicate);
    rows = clampRows(rows * selectivity);

    steps.push(step({
      phase: "where",
      label: "WHERE",
      beforeRows: before,
      afterRows: rows,
      risk: predicateRisk(selectivity, predicate),
      evidence: predicate.text,
      detail: `Estimated selectivity ${(selectivity * 100).toFixed(0)}%.`
    }));
  }

  if (ast.groupBy.length > 0) {
    const before = rows;
    rows = clampRows(Math.max(1, Math.min(rows, rows * groupingFactor(ast))));
    steps.push(step({
      phase: "group",
      label: "GROUP BY",
      beforeRows: before,
      afterRows: rows,
      risk: before / Math.max(rows, 1) > 100 ? "medium" : "low",
      evidence: ast.groupBy.map((entry) => entry.text).join(", "),
      detail: `Groups by ${ast.groupBy.length} expression${ast.groupBy.length === 1 ? "" : "s"}.`
    }));
  }

  for (const predicate of ast.having) {
    const before = rows;
    const selectivity = 0.65;
    rows = clampRows(rows * selectivity);
    steps.push(step({
      phase: "having",
      label: "HAVING",
      beforeRows: before,
      afterRows: rows,
      risk: "low",
      evidence: predicate.text,
      detail: "Aggregate filter applied after grouping."
    }));
  }

  if (ast.orderBy.length > 0) {
    steps.push(step({
      phase: "order",
      label: "ORDER BY",
      beforeRows: rows,
      afterRows: rows,
      risk: ast.limit ? "low" : "medium",
      evidence: ast.orderBy.map((entry) => entry.text).join(", "),
      detail: ast.limit ? "Sort occurs before the final bound." : "Sort is unbounded in the visible SQL."
    }));
  }

  if (ast.limit) {
    const before = rows;
    const limit = Number.parseInt(ast.limit.replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(limit)) rows = Math.min(rows, limit);
    steps.push(step({
      phase: "limit",
      label: "LIMIT",
      beforeRows: before,
      afterRows: rows,
      risk: "info",
      evidence: ast.limit,
      detail: `Result is bounded to ${formatRows(rows)} rows.`
    }));
  }

  const maxRows = Math.max(...steps.map((entry) => entry.afterRows), rows, 0);
  const blastRadius = initialRows > 0 ? maxRows / initialRows : 0;
  const complexity = computeComplexity(ast, diagnosis, blastRadius);

  return {
    steps,
    maxRows,
    finalRows: rows,
    blastRadius,
    complexity
  };
}

export function formatRows(value) {
  const rounded = Math.max(0, Math.round(value));
  return new Intl.NumberFormat("en", { notation: rounded >= 1_000_000 ? "compact" : "standard" }).format(rounded);
}

function estimateJoinRows(leftRows, rightRows, join, table) {
  if (!join.condition || join.type === "cross") {
    return clampRows(leftRows * rightRows);
  }

  const indexedBonus = table?.indexes?.length || table?.primaryKey?.length || table?.foreignKeys?.length ? 0.45 : 0.85;
  const typeFactor = join.type === "left" ? 1.05 : join.type === "full" ? 1.25 : 0.9;
  const equalityFactor = /=/.test(join.condition) ? indexedBonus : 1.2;
  const manySide = Math.max(leftRows, rightRows);
  const boundedSide = Math.min(leftRows, rightRows);
  const estimate = Math.max(leftRows * typeFactor, boundedSide * equalityFactor + manySide * 0.08);

  return clampRows(estimate);
}

function estimatePredicateSelectivity(predicate) {
  const text = predicate.text.toLowerCase();
  if (/\bor\b/.test(text)) return 0.62;
  if (/\blike\s+'%/.test(text) || /\bilike\s+'%/.test(text)) return 0.72;
  if (/\bin\s*\(/.test(text)) return 0.28;
  if (/(=|is)\s*('[^']*'|\d+|true|false|null)/.test(text)) return 0.14;
  if (/>=|<=|>|<|between/.test(text)) return 0.38;
  if (/\bis\s+not\s+null/.test(text)) return 0.82;
  return 0.5;
}

function groupingFactor(ast) {
  if (ast.groupBy.length >= 3) return 0.38;
  if (ast.groupBy.length === 2) return 0.2;
  return 0.09;
}

function sourceRisk(rows) {
  if (rows >= 10_000_000) return "high";
  if (rows >= 500_000) return "medium";
  if (rows >= 50_000) return "low";
  return "info";
}

function joinRisk(before, after, join) {
  if (!join.condition || join.type === "cross") return "high";
  const growth = after / Math.max(before, 1);
  if (growth >= 10) return "high";
  if (growth >= 2.5) return "medium";
  return "low";
}

function predicateRisk(selectivity, predicate) {
  if (/\bnot\s+in\b/i.test(predicate.text)) return "high";
  if (selectivity > 0.7) return "medium";
  if (selectivity < 0.18) return "info";
  return "low";
}

function computeComplexity(ast, diagnosis, blastRadius) {
  const base = 12;
  const joinLoad = ast.joins.length * 10;
  const cteLoad = ast.ctes.length * 5;
  const predicateLoad = (ast.predicates.length + ast.having.length) * 3;
  const groupLoad = ast.groupBy.length > 0 ? 8 : 0;
  const riskLoad = diagnosis.score * 0.32;
  const blastLoad = Math.min(25, Math.log10(Math.max(1, blastRadius)) * 9);
  return Math.round(Math.min(100, base + joinLoad + cteLoad + predicateLoad + groupLoad + riskLoad + blastLoad));
}

function clampRows(value) {
  if (!Number.isFinite(value)) return MAX_ESTIMATE;
  return Math.max(1, Math.min(MAX_ESTIMATE, Math.round(value)));
}

function step({ phase, label, beforeRows, afterRows, risk, evidence = "", detail }) {
  const change = beforeRows > 0 ? afterRows / beforeRows : 1;
  return {
    phase,
    label,
    beforeRows,
    afterRows,
    change,
    risk,
    evidence,
    detail
  };
}
