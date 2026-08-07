import { formatRows } from "./flow.js";
import { lookupColumn, lookupTable, resolveAlias, sourceStats } from "./schema.js";
import { IDENTITY_NAMESPACE, IDENTITY_SCHEMA_VERSION, attachStableIdentity, canonicalClauseText } from "./identity.js";

export function buildReviewProfile({ ast, schema, dialect, diagnosis, flow, flightPlan, sourceModel }) {
  const topFinding = diagnosis.findings[0];
  const firstAction = flightPlan.actions[0];
  const high = diagnosis.severityCounts.high ?? 0;
  const medium = diagnosis.severityCounts.medium ?? 0;
  const grain = inferOutputGrain(ast, sourceModel);
  const contract = inferContract(ast, schema, diagnosis, sourceModel);
  const criticalStep = mostImportantFlowStep(flow);
  const sources = buildSourceInventory(ast, schema);
  const metrics = buildMetricLineage(ast, schema, grain);
  const metricIdentity = attachStableIdentity(metrics.map((metric) => ({
    id: metric.id,
    kind: "metric",
    signature: metricIdentitySignature(metric),
    target: metric
  })), {
    namespace: IDENTITY_NAMESPACE,
    schemaVersion: IDENTITY_SCHEMA_VERSION
  });

  return {
    posture: {
      label: high ? "Hold" : medium ? "Review" : "Ready",
      tone: high ? "high" : medium ? "medium" : "low",
      reason: topFinding?.title || "No blocking static hazards detected"
    },
    summary: [
      `Likely output grain: ${grain.label}.`,
      contract.sensitiveCount ? `${contract.sensitiveCount} sensitive field${contract.sensitiveCount === 1 ? "" : "s"} need an owner decision.` : "No sensitive schema annotations reach the visible result.",
      criticalStep ? `Largest modeled movement: ${criticalStep.label} moves ${formatRows(criticalStep.beforeRows)} -> ${formatRows(criticalStep.afterRows)} rows.` : "No row movement could be modeled."
    ],
    scorecards: [
      {
        label: "Decision",
        value: high ? "Hold" : medium ? "Review" : "Ready",
        detail: high ? `${high} blocking risk${high === 1 ? "" : "s"}` : `${medium} review item${medium === 1 ? "" : "s"}`,
        tone: high ? "high" : medium ? "medium" : "low",
        targetId: findTargetId(sourceModel, topFinding?.evidence),
        mode: "inspect"
      },
      {
        label: "Motion",
        value: `${formatRows(flow.maxRows)} peak`,
        detail: `${flow.blastRadius.toFixed(1)}x blast to ${formatRows(flow.finalRows)} final`,
        tone: flow.blastRadius >= 3 ? "medium" : "low",
        mode: "atlas"
      },
      {
        label: "Grain",
        value: grain.value,
        detail: grain.detail,
        tone: grain.tone,
        targetId: grain.targetId,
        mode: "inspect"
      },
      {
        label: "Contract",
        value: contract.value,
        detail: contract.detail,
        tone: contract.tone,
        targetId: contract.targetId,
        mode: "inspect"
      },
      {
        label: "Fix",
        value: firstAction ? `${flightPlan.impact.beforeRisk}->${flightPlan.impact.afterRisk}` : "Validate",
        detail: firstAction?.title || "Compare runtime plan",
        tone: firstAction?.severity || "info",
        targetId: firstAction?.targetId || "",
        flightId: firstAction?.id || "",
        mode: firstAction ? "fix" : "inspect"
      }
    ],
    audience: buildAudienceReadouts({ ast, dialect, diagnosis, flow, flightPlan, contract, grain, criticalStep, topFinding, firstAction, sources, metrics }),
    hotspots: buildHotspots({ diagnosis, flow, flightPlan, sourceModel }),
    questions: buildBusinessQuestions({ ast, schema, diagnosis, dialect, flow, contract, grain }),
    grain,
    contract,
    criticalStep,
    sources,
    metrics,
    identity: {
      metrics: metricIdentity
    }
  };
}

function buildAudienceReadouts({ ast, dialect, diagnosis, flow, flightPlan, contract, grain, criticalStep, topFinding, firstAction, sources, metrics }) {
  const high = diagnosis.severityCounts.high ?? 0;
  const countRisk = diagnosis.findings.find((finding) => finding.title.includes("COUNT(*)") || finding.title.includes("DISTINCT"));
  const accessRisk = diagnosis.findings.find((finding) => ["performance", "dialect"].includes(finding.category));
  const missingSources = sources.filter((source) => source.schemaStatus !== "known").length;

  return {
    manager: {
      label: high ? "Hold" : diagnosis.score >= 25 ? "Review" : "Ready",
      detail: contract.sensitiveCount
        ? `${contract.sensitiveCount} sensitive contract risk${contract.sensitiveCount === 1 ? "" : "s"} before handoff`
        : topFinding?.title || "No blocking static issue detected",
      tone: high ? "high" : diagnosis.score >= 25 ? "medium" : "low"
    },
    analyst: {
      label: metrics.length ? `${metrics.length} metric${metrics.length === 1 ? "" : "s"}` : grain.value,
      detail: countRisk?.title || metrics[0]?.businessMeaning || `${ast.projections.length} projected field${ast.projections.length === 1 ? "" : "s"} at ${grain.label}`,
      tone: countRisk ? countRisk.severity : grain.tone
    },
    engineer: {
      label: `${dialect.label} / ${formatRows(flow.maxRows)} peak`,
      detail: missingSources ? `${missingSources} source${missingSources === 1 ? "" : "s"} missing schema context` : firstAction?.title || accessRisk?.title || criticalStep?.label || `${flightPlan.actions.length} repair maneuver${flightPlan.actions.length === 1 ? "" : "s"}`,
      tone: firstAction?.severity || accessRisk?.severity || criticalStep?.risk || "info"
    }
  };
}

function buildSourceInventory(ast, schema) {
  const stats = sourceStats(ast, schema);
  const rows = [];

  collectCteInventoryAssets(ast).forEach((asset, index) => {
    const table = lookupTable(schema, asset.source.name);
    const inventory = sourceInventoryRow({
      ast,
      schema,
      source: asset.source,
      stat: {
        table,
        rows: table?.rowCount ?? asset.source.defaultRows ?? 10000
      },
      id: `asset-${index}`,
      role: asset.consumers.size > 1 ? "Shared CTE source" : "CTE source"
    });
    inventory.detail = `${asset.consumers.size} CTE stage${asset.consumers.size === 1 ? "" : "s"} / ${inventory.detail}`;
    rows.push(inventory);
  });

  ast.ctes.forEach((cte, index) => {
    rows.push(cteInventoryRow(cte, index));
  });

  ast.sources.forEach((source, index) => {
    rows.push(sourceInventoryRow({
      ast,
      schema,
      source,
      stat: stats.find((entry) => entry.source === source),
      id: `source-${index}`,
      role: source.type === "cte" ? "CTE seed" : source.type === "subquery" ? "Subquery seed" : "Base source"
    }));
  });

  ast.joins.forEach((join, index) => {
    rows.push(sourceInventoryRow({
      ast,
      schema,
      source: join.source,
      stat: stats.find((entry) => entry.source === join.source),
      id: `join-${index}`,
      role: `${join.type.toUpperCase()} join`,
      join
    }));
  });

  return rows;
}

function collectCteInventoryAssets(ast) {
  const cteNames = new Set(ast.ctes.map((cte) => normalId(cte.name)));
  const assets = new Map();

  for (const cte of ast.ctes) {
    const sources = [
      ...(cte.statement?.sources ?? []),
      ...(cte.statement?.joins ?? []).map((join) => join.source)
    ];
    for (const source of sources) {
      const key = normalId(source?.name);
      if (!key || cteNames.has(key)) continue;
      if (!assets.has(key)) assets.set(key, { source, consumers: new Set() });
      assets.get(key).consumers.add(cte.name);
    }
  }

  return [...assets.values()];
}

function cteInventoryRow(cte, index) {
  const projectionCount = cte.statement?.projections?.length ?? 0;
  const internalSources = (cte.statement?.sources?.length ?? 0) + (cte.statement?.joins?.length ?? 0);
  const wildcard = cte.statement?.projections?.some((projection) => projection.wildcard);

  return {
    id: `cte-${index}`,
    role: "CTE block",
    name: cte.displayName || cte.name,
    alias: "",
    type: "cte",
    rows: 10000,
    schemaStatus: "derived",
    columnCount: projectionCount,
    indexCount: 0,
    joinCondition: "",
    joinType: "",
    joinKeys: [],
    indexedJoinKeys: 0,
    totalJoinKeys: 0,
    tone: wildcard ? "medium" : "info",
    detail: `${projectionCount} recovered field${projectionCount === 1 ? "" : "s"}, ${internalSources} internal source${internalSources === 1 ? "" : "s"}.`
  };
}

function sourceInventoryRow({ ast, schema, source, stat, id, role, join = null }) {
  const table = stat?.table || null;
  const rows = stat?.rows ?? source.defaultRows ?? 10000;
  const schemaStatus = table ? "known" : source.type === "cte" ? "derived" : "missing";
  const joinIndex = join ? joinIndexCoverage(ast, schema, join) : null;
  const tone = join?.risky ? "high"
    : schemaStatus === "missing" ? "medium"
      : rows >= 10_000_000 ? "high"
        : rows >= 500_000 ? "medium"
          : "low";

  return {
    id,
    role,
    name: source.displayName || source.name || "unknown source",
    alias: source.alias || "",
    type: source.type,
    rows,
    schemaStatus,
    columnCount: table?.columns?.size ?? 0,
    indexCount: table?.indexes?.length ?? 0,
    joinCondition: join?.condition || "",
    joinType: join?.type || "",
    joinKeys: join?.references?.map((reference) => reference.text) ?? [],
    indexedJoinKeys: joinIndex?.indexed ?? 0,
    totalJoinKeys: joinIndex?.total ?? 0,
    tone,
    detail: sourceDetail({ rows, schemaStatus, table, joinIndex, join })
  };
}

function sourceDetail({ rows, schemaStatus, table, joinIndex, join }) {
  if (join?.risky) return "No safe join predicate is visible.";
  if (joinIndex && joinIndex.total > 0) {
    return `${joinIndex.indexed}/${joinIndex.total} join key${joinIndex.total === 1 ? "" : "s"} indexed in schema notes.`;
  }
  if (schemaStatus === "missing") return "Schema notes missing, so key and sensitivity checks are conservative.";
  if (schemaStatus === "derived") return "Derived source from a CTE or subquery.";
  return `${formatRows(rows)} rows, ${table?.columns?.size ?? 0} column${table?.columns?.size === 1 ? "" : "s"}, ${table?.indexes?.length ?? 0} index note${table?.indexes?.length === 1 ? "" : "s"}.`;
}

function joinIndexCoverage(ast, schema, join) {
  let total = 0;
  let indexed = 0;

  for (const reference of join.references ?? []) {
    total += 1;
    const tableName = resolveAlias(ast, reference.qualifier);
    const table = lookupTable(schema, tableName);
    if (!table) continue;
    if (isIndexed(table, reference.column)) indexed += 1;
  }

  return { total, indexed };
}

function isIndexed(table, columnName) {
  const normalized = normalId(columnName);
  return table.primaryKey.includes(normalized)
    || table.indexes.some((index) => index.columns[0] === normalized)
    || table.foreignKeys.some((key) => key.column === normalized);
}

function buildMetricLineage(ast, schema, grain) {
  const sourceMap = buildSourceIdMap(ast);
  const metrics = [];

  for (const projection of ast.projections) {
    if (!isMetricProjection(projection)) continue;
    const sources = projection.references
      .map((reference) => metricReference(ast, schema, sourceMap, reference))
      .filter(Boolean);
    const sensitive = sources.some((reference) => reference.sensitive);
    const countAfterJoin = /\bcount\s*\(\s*\*\s*\)/i.test(projection.text) && ast.joins.length > 0;
    const tone = sensitive ? "high" : countAfterJoin ? "medium" : projection.aggregate || projection.windowed ? "low" : "info";

    metrics.push({
      id: `projection-${projection.index}`,
      label: projection.alias || projection.text,
      expression: projection.text,
      type: projection.windowed ? "Window metric" : projection.aggregate ? "Aggregate metric" : "Derived metric",
      grain: grain.label,
      sources: uniqueBy(sources, (entry) => `${entry.sourceId}:${entry.column}`),
      dependsOnIds: unique(sources.map((entry) => entry.sourceId).filter(Boolean)),
      tone,
      businessMeaning: metricMeaning(projection),
      risk: sensitive
        ? "Uses a sensitive input field."
        : countAfterJoin
          ? "COUNT(*) runs after joins and can inflate entity counts."
          : projection.windowed
            ? "Window output depends on partition and ordering rules."
            : "Metric has traceable static inputs."
    });
  }

  ast.ctes.forEach((cte, cteIndex) => {
    const statement = cte.statement;
    if (!statement?.projections?.length) return;
    const cteSourceMap = buildSourceIdMap(statement);
    for (const projection of statement.projections) {
      if (!isMetricProjection(projection)) continue;
      const sources = projection.references
        .map((reference) => metricReference(statement, schema, cteSourceMap, reference))
        .filter(Boolean);
      const sensitive = sources.some((reference) => reference.sensitive);
      const countAfterJoin = /\bcount\s*\(\s*\*\s*\)/i.test(projection.text) && statement.joins.length > 0;
      metrics.push({
        id: `cte-${cteIndex}`,
        label: `${cte.displayName}.${projection.alias || projection.text}`,
        expression: projection.text,
        type: `CTE ${projection.windowed ? "window metric" : projection.aggregate ? "aggregate metric" : "derived metric"}`,
        grain: cte.displayName,
        sources: uniqueBy(sources, (entry) => `${entry.table}:${entry.column}`),
        dependsOnIds: [`cte-${cteIndex}`],
        tone: sensitive ? "high" : countAfterJoin ? "medium" : "low",
        businessMeaning: metricMeaning(projection),
        risk: sensitive
          ? "Uses a sensitive input field inside a CTE."
          : countAfterJoin
            ? "COUNT(*) runs after joins inside this CTE."
            : "Recovered from a CTE even though the full model may be damaged."
      });
    }
  });

  return metrics.length ? metrics : ast.projections.slice(0, 8).map((projection) => {
    const sources = projection.references.map((reference) => metricReference(ast, schema, sourceMap, reference)).filter(Boolean);
    return {
      id: `projection-${projection.index}`,
      label: projection.alias || projection.text,
      expression: projection.text,
      type: projection.wildcard ? "Wildcard field set" : "Result field",
      grain: grain.label,
      sources,
      dependsOnIds: unique(sources.map((entry) => entry.sourceId).filter(Boolean)),
      tone: projection.wildcard ? "medium" : "info",
      businessMeaning: projection.wildcard ? "Exports a moving field contract." : "Visible output field.",
      risk: projection.wildcard ? "New upstream columns can appear in the result." : "No metric-specific risk inferred."
    };
  });
}

function isMetricProjection(projection) {
  const label = `${projection.alias || ""} ${projection.text}`;
  return projection.aggregate
    || projection.windowed
    || /\bcase\b/i.test(projection.text)
    || /[-+*/]\s*[\w"(]/.test(projection.text)
    || /\b(count|sum|avg|rate|ratio|pct|percent|revenue|cost|amount|total|score|metric|margin|gmv|mrr|arr|duration|latency|qty|quantity|price)\b/i.test(label);
}

function metricReference(ast, schema, sourceMap, reference) {
  const tableName = resolveAlias(ast, reference.qualifier);
  const table = lookupTable(schema, tableName);
  const column = lookupColumn(table, reference.column);
  const sourceId = sourceMap.get(normalId(reference.qualifier)) || sourceMap.get(normalId(tableName)) || "";

  return {
    sourceId,
    table: table?.displayName || tableName || reference.qualifier || "unknown",
    column: column?.displayName || reference.column,
    type: column?.type || "unknown",
    sensitive: Boolean(column?.sensitive)
  };
}

function metricIdentitySignature(metric) {
  return {
    kind: "metric",
    label: canonicalClauseText(metric.label || ""),
    type: metric.type,
    expression: canonicalClauseText(metric.expression || ""),
    grain: canonicalClauseText(metric.grain || ""),
    dependsOnIds: [...new Set(metric.dependsOnIds)].sort(),
    tone: metric.tone,
    risk: canonicalClauseText(metric.risk || "")
  };
}

function metricMeaning(projection) {
  const label = `${projection.alias || ""} ${projection.text}`.toLowerCase();
  if (/\bcount\b/.test(label)) return "Counts rows or entities; verify the intended entity level.";
  if (/\brevenue|amount|price|cost|gmv|mrr|arr\b/.test(label)) return "Financial measure; verify grain, currency, and duplication.";
  if (/\brate|ratio|pct|percent|margin\b/.test(label)) return "Ratio measure; verify denominator and null handling.";
  if (/\brow_number|rank|dense_rank|ntile\b/.test(label)) return "Ranking measure; verify deterministic ordering.";
  if (/\bcase\b/.test(label)) return "Business rule encoded in SQL; verify branch coverage.";
  return "Derived output measure.";
}

function buildSourceIdMap(ast) {
  const map = new Map();
  ast.sources.forEach((source, index) => {
    addSourceKeys(map, source, `source-${index}`);
  });
  ast.joins.forEach((join, index) => {
    addSourceKeys(map, join.source, `join-${index}`);
  });
  return map;
}

function addSourceKeys(map, source, id) {
  for (const key of [source.alias, source.name, source.displayName].filter(Boolean)) {
    map.set(normalId(key), id);
    map.set(normalId(String(key).split(".").at(-1)), id);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function normalId(value) {
  return String(value || "").replace(/^[`"\[]|[`"\]]$/g, "").toLowerCase();
}

function inferOutputGrain(ast, sourceModel) {
  const projectionTarget = firstSourceModelIdByKind(sourceModel, "projection");
  if (ast.groupBy.length > 0) {
    const fields = ast.groupBy.map((entry) => entry.text).filter(Boolean);
    return {
      value: `${fields.length} key${fields.length === 1 ? "" : "s"}`,
      label: fields.slice(0, 4).join(", "),
      detail: `Grouped result over ${fields.length} expression${fields.length === 1 ? "" : "s"}.`,
      tone: fields.length > 4 ? "medium" : "low",
      targetId: firstSourceModelIdByKind(sourceModel, "group") || firstSourceModelIdByKind(sourceModel, "where") || projectionTarget
    };
  }

  const aggregates = ast.projections.filter((projection) => projection.aggregate).length;
  if (aggregates > 0) {
    return {
      value: "Aggregate",
      label: "single aggregate grain unless filtered by hidden grouping",
      detail: `${aggregates} aggregate projection${aggregates === 1 ? "" : "s"} without a visible GROUP BY.`,
      tone: "medium",
      targetId: projectionTarget
    };
  }

  const fields = ast.projections
    .filter((projection) => !projection.wildcard)
    .slice(0, 3)
    .map((projection) => projection.alias || projection.text);
  return {
    value: fields.length ? "Rows" : "Unknown",
    label: fields.join(", ") || "projection-driven",
    detail: ast.joins.length ? "Row grain depends on join cardinality." : "Row grain follows the base source.",
    tone: ast.joins.length ? "medium" : "info",
    targetId: projectionTarget
  };
}

function inferContract(ast, schema, diagnosis, sourceModel) {
  const sensitive = diagnosis.findings.filter((finding) => finding.category === "privacy");
  const wildcard = ast.projections.find((projection) => projection.wildcard);
  const targetId = wildcard ? projectionIdForIndex(sourceModel, wildcard.index) : firstSourceModelIdByKind(sourceModel, "projection");
  if (sensitive.length > 0) {
    return {
      value: "Sensitive",
      detail: `${sensitive.length} privacy finding${sensitive.length === 1 ? "" : "s"} in result contract`,
      tone: "high",
      sensitiveCount: sensitive.length,
      targetId
    };
  }

  if (wildcard) {
    return {
      value: "Wide",
      detail: "SELECT * can change when upstream schema changes",
      tone: "medium",
      sensitiveCount: 0,
      targetId
    };
  }

  return {
    value: "Explicit",
    detail: `${ast.projections.length} projection${ast.projections.length === 1 ? "" : "s"}, ${schema.tables.size} schema table${schema.tables.size === 1 ? "" : "s"}`,
    tone: "low",
    sensitiveCount: 0,
    targetId
  };
}

function firstSourceModelIdByKind(sourceModel, kind) {
  return sourceModelEntriesByKind(sourceModel, kind)[0]?.id || "";
}

function projectionIdForIndex(sourceModel, index) {
  const entries = sourceModelEntriesByKind(sourceModel, "projection");
  return entries[index]?.id || firstSourceModelIdByKind(sourceModel, "projection");
}

function sourceModelEntriesByKind(sourceModel, kind) {
  return [...(sourceModel?.entries ?? [])].filter((entry) => entry.kind === kind);
}

function mostImportantFlowStep(flow) {
  return [...flow.steps].sort((a, b) => {
    const aMovement = Math.abs(Math.log10(Math.max(a.change, 0.01)));
    const bMovement = Math.abs(Math.log10(Math.max(b.change, 0.01)));
    return bMovement - aMovement;
  })[0] || null;
}

function buildHotspots({ diagnosis, flow, flightPlan, sourceModel }) {
  const hotspots = [];
  for (const finding of diagnosis.findings.slice(0, 3)) {
    hotspots.push({
      kind: "finding",
      label: finding.title,
      detail: finding.suggestion || finding.detail,
      tone: finding.severity,
      targetId: findTargetId(sourceModel, finding.evidence)
    });
  }

  const step = mostImportantFlowStep(flow);
  if (step) {
    hotspots.push({
      kind: "motion",
      label: step.label,
      detail: `${formatRows(step.beforeRows)} -> ${formatRows(step.afterRows)} rows`,
      tone: step.risk,
      targetId: findTargetId(sourceModel, step.evidence)
    });
  }

  const action = flightPlan.actions[0];
  if (action) {
    hotspots.push({
      kind: "fix",
      label: action.title,
      detail: action.maneuver,
      tone: action.severity,
      targetId: action.targetId,
      flightId: action.id
    });
  }

  return hotspots.slice(0, 5);
}

function buildBusinessQuestions({ ast, schema, diagnosis, dialect, flow, contract, grain }) {
  const questions = [];
  if (schema.tables.size === 0) {
    questions.push("What row counts, indexes, and sensitive fields should anchor this review?");
  }
  if (contract.sensitiveCount > 0) {
    questions.push("Who owns approval for the sensitive output contract?");
  }
  if (ast.joins.length > 0) {
    questions.push(`Is the intended grain really ${grain.label}, or did a join duplicate it?`);
  }
  if (flow.blastRadius >= 3) {
    questions.push("Can the largest row expansion be filtered or pre-aggregated earlier?");
  }
  if (dialect.confidence !== "high") {
    questions.push("Which warehouse dialect will execute this model?");
  }
  if (diagnosis.findings.some((finding) => finding.title.includes("COUNT(*)"))) {
    questions.push("Should the business metric count rows, entities, or distinct keys?");
  }
  if (questions.length === 0) {
    questions.push("Does the warehouse EXPLAIN plan agree with this static model?");
  }
  return questions.slice(0, 5);
}

function findTargetId(sourceModel, evidence) {
  const normalized = normalizeEvidence(evidence);
  if (!normalized) return "";
  return sourceModel.traceLines.find((entry) => normalizeEvidence(entry.text) === normalized)?.id || "";
}

function normalizeEvidence(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}
