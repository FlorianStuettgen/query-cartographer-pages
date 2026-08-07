import { formatRows } from "./flow.js";
import { isKeyword, tokenize, tokensToText } from "./tokenizer.js";

const PARAMETERIZED_CLAUSES = new Set(["where", "having", "on"]);

export function buildRewrite(ast, diagnosis, flow) {
  const parameterized = parameterizeSql(ast.sql ?? "");
  const notes = buildNotes(ast, diagnosis, flow);

  return {
    sql: parameterized.sql,
    params: parameterized.params,
    notes
  };
}

export function parameterizeSql(sql) {
  const tokens = tokenize(sql);
  const params = [];
  let activeClause = "";

  const rewritten = tokens.map((token) => {
    if (isKeyword(token, "where") || isKeyword(token, "having") || isKeyword(token, "on")) {
      activeClause = token.normalized;
      return token;
    }

    if (["group", "order", "limit", "offset", "union"].includes(token.normalized)) {
      activeClause = "";
      return token;
    }

    if (PARAMETERIZED_CLAUSES.has(activeClause) && ["string", "number"].includes(token.type)) {
      const name = `p${params.length + 1}`;
      params.push({ name, value: token.value, type: token.type, clause: activeClause });
      return { ...token, value: `:${name}`, normalized: `:${name}`, type: "word" };
    }

    return token;
  });

  return {
    sql: tokensToText(rewritten),
    params
  };
}

export function buildMarkdownReport(analysis) {
  const { ast, schema, diagnosis, flow, rewrite, formattedSql = "", sourceModel = null, flightPlan = null, dialect = null, briefing = null } = analysis;
  const lines = [];

  lines.push("# Query Cartographer Report");
  lines.push("");
  lines.push(`Risk level: ${diagnosis.riskLevel}`);
  lines.push(`Risk score: ${diagnosis.score}/100`);
  lines.push(`Complexity: ${flow.complexity}/100`);
  lines.push(`Final row estimate: ${formatRows(flow.finalRows)}`);
  lines.push(`Sources: ${[...ast.sources, ...ast.joins.map((join) => join.source)].map((source) => source.displayName || source.name).join(", ") || "none"}`);
  lines.push(`Schema tables loaded: ${schema.tables.size}`);
  if (dialect) {
    lines.push(`Dialect: ${dialect.label} (${dialect.confidence} confidence)`);
  }
  lines.push("");

  if (dialect?.signals?.length) {
    lines.push("## Dialect Signals");
    for (const signal of dialect.signals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
  }

  if (briefing) {
    lines.push("## Review Briefing");
    lines.push(`${briefing.disposition.label}: ${briefing.headline}`);
    lines.push(briefing.readout);
    lines.push("");
    for (const entry of briefing.narrative) {
      lines.push(`- ${entry.label}: ${entry.value}. ${entry.detail}`);
    }
    lines.push("");
  }

  lines.push("## Findings");
  for (const entry of diagnosis.findings) {
    lines.push(`- [${entry.severity.toUpperCase()}] ${entry.title}: ${entry.detail}`);
    if (entry.suggestion) lines.push(`  Suggestion: ${entry.suggestion}`);
  }
  lines.push("");

  lines.push("## Flow");
  for (const step of flow.steps) {
    lines.push(`- ${step.label}: ${formatRows(step.beforeRows)} -> ${formatRows(step.afterRows)} (${step.risk})`);
  }
  lines.push("");

  if (sourceModel?.traceLines?.length) {
    lines.push("## Semantic Trace");
    for (const entry of sourceModel.traceLines) {
      const line = entry.lineStart ? `L${entry.lineStart}` : "derived";
      lines.push(`- ${entry.id} ${line}: ${entry.label}`);
    }
    lines.push("");
  }

  if (formattedSql) {
    lines.push("## Formatted SQL");
    lines.push("```sql");
    lines.push(formattedSql);
    lines.push("```");
    lines.push("");
  }

  if (flightPlan?.actions?.length) {
    lines.push("## Flight Plan");
    lines.push(`Projected risk: ${flightPlan.impact.beforeRisk}/100 -> ${flightPlan.impact.afterRisk}/100`);
    lines.push(`Projected complexity: ${flightPlan.impact.beforeComplexity}/100 -> ${flightPlan.impact.afterComplexity}/100`);
    for (const action of flightPlan.actions) {
      lines.push(`- [${action.severity.toUpperCase()}] ${action.title}: ${action.maneuver}`);
      if (action.targetLabel) lines.push(`  Target: ${action.targetLabel}`);
    }
    lines.push("");

    if (flightPlan.draftSql && flightPlan.draftSql !== ast.sql) {
      lines.push("## Flight Plan Draft");
      lines.push("```sql");
      lines.push(flightPlan.draftSql);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Parameterized SQL");
  lines.push("```sql");
  lines.push(rewrite.sql || ast.sql || "");
  lines.push("```");

  if (rewrite.params.length > 0) {
    lines.push("");
    lines.push("## Parameters");
    for (const param of rewrite.params) {
      lines.push(`- :${param.name} = ${param.value}`);
    }
  }

  return lines.join("\n");
}

function buildNotes(ast, diagnosis, flow) {
  const notes = [];

  if (ast.projections.some((projection) => projection.wildcard)) {
    notes.push(note(
      "Name the result contract",
      "Replace wildcards with explicit columns so reviews can see privacy and downstream dependency impact."
    ));
  }

  if (ast.joins.some((join) => !join.condition || join.type === "cross")) {
    notes.push(note(
      "Fence row multiplication",
      "Add join predicates or row-count guards around cartesian intent before this query runs on large tables."
    ));
  }

  if (diagnosis.findings.some((entry) => entry.title.includes("LEFT JOIN"))) {
    notes.push(note(
      "Preserve outer-join intent",
      "Move nullable-side filters from WHERE into the JOIN clause unless the inner-join behavior is intended."
    ));
  }

  if (diagnosis.findings.some((entry) => entry.title.includes("NOT IN"))) {
    notes.push(note(
      "Avoid null-sensitive anti-joins",
      "Rewrite NOT IN as NOT EXISTS and make the correlation explicit."
    ));
  }

  if (flow.blastRadius >= 10) {
    notes.push(note(
      "Stage the largest expansion",
      `The row-flow model peaks at ${flow.blastRadius.toFixed(1)}x the seed relation. Pre-aggregate or filter before that step.`
    ));
  }

  if (ast.orderBy.length > 0 && !ast.limit) {
    notes.push(note(
      "Bound exploratory sorts",
      "Add a LIMIT while investigating, then remove it only when the complete ordered set is truly required."
    ));
  }

  if (notes.length === 0) {
    notes.push(note(
      "Runtime plan still matters",
      "Static analysis found no urgent rewrite target. Compare against EXPLAIN with representative parameters."
    ));
  }

  return notes;
}

function note(title, detail) {
  return { title, detail };
}
