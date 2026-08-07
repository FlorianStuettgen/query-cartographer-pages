import { tokenize } from "./tokenizer.js";
import { IDENTITY_NAMESPACE, IDENTITY_SCHEMA_VERSION, attachStableIdentity, canonicalClauseText } from "./identity.js";

const SEVERITY_DELTA = {
  high: 24,
  medium: 12,
  low: 5,
  info: 1
};

export function buildFlightPlan(ast, diagnosis, flow, sourceModel) {
  if (ast.unsupported || !ast.sql?.trim()) {
    return emptyPlan(ast.sql || "");
  }

  const candidates = diagnosis.findings
    .flatMap((finding) => actionForFinding(finding, ast, sourceModel))
    .filter(Boolean);

  const ranked = dedupeActions(candidates)
    .sort((a, b) => b.riskDelta - a.riskDelta || b.complexityDelta - a.complexityDelta);
  const draftActions = ranked.filter((action) => action.applyInPlan);
  const reviewActions = ranked.filter((action) => !action.applyInPlan);
  const actions = [...draftActions, ...reviewActions.slice(0, Math.max(0, 8 - draftActions.length))]
    .sort((a, b) => b.riskDelta - a.riskDelta || b.complexityDelta - a.complexityDelta);

  let draftSql = ast.sql;
  for (const action of actions) {
    action.previewSql = action.apply ? action.apply(ast.sql) : ast.sql;
    if (action.applyInPlan) {
      const next = action.apply(draftSql);
      action.applied = next !== draftSql;
      draftSql = next;
    }
  }

  const identity = attachStableIdentity(actions.map((action) => ({
    id: action.id,
    kind: "flight-action",
    signature: flightActionIdentitySignature(action),
    target: action
  })), {
    namespace: IDENTITY_NAMESPACE,
    schemaVersion: IDENTITY_SCHEMA_VERSION
  });

  return {
    actions: actions.map(publicAction),
    draftSql,
    impact: estimateImpact(diagnosis, flow, actions),
    checklist: buildChecklist(actions),
    identity
  };
}

function emptyPlan(sql) {
  return {
    actions: [],
    draftSql: sql,
    impact: {
      beforeRisk: 0,
      afterRisk: 0,
      beforeComplexity: 0,
      afterComplexity: 0,
      beforePeakRows: 0,
      afterPeakRows: 0,
      rowsAvoided: 0
    },
    checklist: [],
    identity: attachStableIdentity([], {
      namespace: IDENTITY_NAMESPACE,
      schemaVersion: IDENTITY_SCHEMA_VERSION
    })
  };
}

function actionForFinding(finding, ast, sourceModel) {
  const targetId = targetIdForEvidence(sourceModel, finding.evidence, preferredKindsFor(finding));
  const base = {
    id: actionId(finding),
    severity: finding.severity,
    category: finding.category,
    evidence: finding.evidence,
    targetId,
    targetLabel: targetId ? sourceModel.registry.get(targetId)?.label ?? "" : "",
    why: finding.detail,
    confidence: "medium",
    rowFactor: 1,
    riskDelta: SEVERITY_DELTA[finding.severity] ?? 1,
    complexityDelta: finding.severity === "high" ? 8 : finding.severity === "medium" ? 5 : 2,
    applied: false,
    apply: null,
    applyInPlan: false
  };

  if (finding.title === "WHERE clause can erase LEFT JOIN preservation") {
    return [{
      ...base,
      id: `${base.id}-preserve-left-join`,
      title: "Move nullable-side filter into the LEFT JOIN",
      maneuver: "Preserve outer-join intent before downstream filtering.",
      confidence: "high",
      rowFactor: 0.88,
      complexityDelta: 10,
      apply: (sql) => movePredicateIntoLeftJoin(sql, ast, finding.evidence),
      applyInPlan: true
    }];
  }

  if (finding.title === "NOT IN can fail in the presence of NULL") {
    return [{
      ...base,
      id: `${base.id}-null-safe-anti-filter`,
      title: "Make the anti-filter NULL-safe",
      maneuver: "Fence three-valued logic so NULL cannot erase the result set.",
      confidence: "high",
      complexityDelta: 9,
      apply: (sql) => rewriteNullSensitiveNotIn(sql, finding.evidence),
      applyInPlan: true
    }];
  }

  if (finding.title === "Sensitive field reaches the result set") {
    return [{
      ...base,
      id: `${base.id}-${hashText(finding.evidence)}`,
      title: "Redact or justify the sensitive projection",
      maneuver: "Treat this output column as an explicit data contract decision.",
      confidence: "medium",
      riskDelta: 26,
      complexityDelta: 4
    }];
  }

  if (finding.title === "ORDER BY has no result bound") {
    return [{
      ...base,
      id: `${base.id}-limit-guard`,
      title: "Add an exploratory result bound",
      maneuver: "Keep unbounded sorts out of review and ad-hoc paths.",
      confidence: "high",
      rowFactor: 0.72,
      apply: (sql) => addLimitGuard(sql, ast),
      applyInPlan: true
    }];
  }

  if (finding.title === "OFFSET pagination grows slower with depth") {
    return [{
      ...base,
      id: `${base.id}-keyset-pagination`,
      title: "Replace deep OFFSET with keyset pagination",
      maneuver: "Carry the last-seen sort key instead of discarding prior pages.",
      confidence: "medium",
      rowFactor: 0.8
    }];
  }

  if (finding.title === "OR predicate may block selective access paths") {
    return [{
      ...base,
      id: `${base.id}-branch-or`,
      title: "Split independent OR branches",
      maneuver: "Review each branch as a targeted access path before UNION ALL.",
      confidence: "medium",
      rowFactor: 0.68,
      complexityDelta: 7
    }];
  }

  if (finding.title === "Leading wildcard prevents normal index seeks") {
    return [{
      ...base,
      id: `${base.id}-search-index`,
      title: "Move substring search onto a search-shaped index",
      maneuver: "Use a trigram, full-text, or lookup strategy instead of a leading wildcard scan.",
      confidence: "medium",
      rowFactor: 0.62,
      complexityDelta: 5
    }];
  }

  if (finding.title === "Function-wrapped column is likely non-sargable") {
    return [{
      ...base,
      id: `${base.id}-sargable-expression`,
      title: "Make the predicate sargable",
      maneuver: "Move transformations to parameters, generated columns, or matching functional indexes.",
      confidence: "medium",
      rowFactor: 0.7,
      complexityDelta: 5
    }];
  }

  if (finding.title === "Join column is not indexed in schema notes") {
    return [{
      ...base,
      id: `${base.id}-${hashText(finding.detail)}`,
      title: "Confirm the join-key access path",
      maneuver: "Add or document the index before trusting the row-flow estimate.",
      confidence: "medium",
      rowFactor: 0.58,
      complexityDelta: 4
    }];
  }

  if (finding.title === "COUNT(*) occurs after joins") {
    return [{
      ...base,
      id: `${base.id}-stable-count`,
      title: "Count the entity, not the joined row",
      maneuver: "Pre-aggregate the many side or count a stable key intentionally.",
      confidence: "medium",
      rowFactor: 0.83,
      complexityDelta: 6
    }];
  }

  if (finding.title === "DISTINCT may be hiding join duplication") {
    return [{
      ...base,
      id: `${base.id}-duplication-proof`,
      title: "Prove the join cardinality before DISTINCT",
      maneuver: "Replace deduplication as a symptom with a cardinality test or constrained join.",
      confidence: "medium",
      rowFactor: 0.9,
      complexityDelta: 4
    }];
  }

  if (finding.title === "Wildcard projection broadens the blast radius" || finding.title === "CTE exports wildcard columns") {
    return [{
      ...base,
      id: `${base.id}-explicit-contract`,
      title: "Name the column contract",
      maneuver: "Turn wildcard output into reviewed column intent.",
      confidence: "medium",
      riskDelta: 14,
      complexityDelta: 4
    }];
  }

  return [];
}

function estimateImpact(diagnosis, flow, actions) {
  const totalRiskDelta = actions.reduce((total, action) => total + action.riskDelta, 0);
  const totalComplexityDelta = actions.reduce((total, action) => total + action.complexityDelta, 0);
  const rowFactor = actions.reduce((factor, action) => factor * action.rowFactor, 1);
  const unresolvedReviewFloor = actions.some((action) => !action.applyInPlan) ? 18 : 0;
  const afterRisk = Math.max(unresolvedReviewFloor, diagnosis.score - Math.round(totalRiskDelta * 0.72));
  const afterPeakRows = Math.max(flow.finalRows, Math.round(flow.maxRows * Math.max(0.18, rowFactor)));

  return {
    beforeRisk: diagnosis.score,
    afterRisk,
    beforeComplexity: flow.complexity,
    afterComplexity: Math.max(0, flow.complexity - Math.round(totalComplexityDelta * 0.72)),
    beforePeakRows: flow.maxRows,
    afterPeakRows,
    rowsAvoided: Math.max(0, flow.maxRows - afterPeakRows)
  };
}

function buildChecklist(actions) {
  if (actions.length === 0) {
    return ["Compare the static atlas with an engine EXPLAIN plan before production use."];
  }

  return actions.slice(0, 5).map((action) => action.title);
}

function movePredicateIntoLeftJoin(sql, ast, evidence) {
  if (!evidence) return sql;
  const join = ast.joins.find((entry) => {
    if (entry.type !== "left") return false;
    const names = [entry.source.alias, entry.source.name, entry.source.displayName].filter(Boolean);
    return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\.`, "i").test(evidence));
  });

  if (!join?.condition) return sql;
  const withJoinGuard = replaceLoose(sql, join.condition, `(${join.condition}) AND (${evidence})`);
  return removePredicateFromWhere(withJoinGuard, evidence);
}

function rewriteNullSensitiveNotIn(sql, evidence) {
  const match = String(evidence || "").match(/^(.+?)\s+not\s+in\s*\((.*)\)$/i);
  if (!match) return sql;

  const left = match[1].trim();
  const values = match[2]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && !/^null$/i.test(value));

  const replacement = values.length
    ? `${left} IS NOT NULL AND ${left} NOT IN (${values.join(", ")})`
    : `${left} IS NOT NULL`;
  return replaceLoose(sql, evidence, replacement);
}

function addLimitGuard(sql, ast) {
  if (ast.limit) return sql;
  const trimmed = sql.trimEnd();
  const semicolon = trimmed.endsWith(";") ? ";" : "";
  const body = semicolon ? trimmed.slice(0, -1).trimEnd() : trimmed;

  if (ast.offset && /\boffset\b/i.test(body)) {
    return body.replace(/\boffset\b/i, "LIMIT 500\nOFFSET") + semicolon;
  }

  return `${body}\nLIMIT 500${semicolon}`;
}

function removePredicateFromWhere(sql, evidence) {
  const pattern = loosePattern(evidence);
  const whereThenAnd = new RegExp(`(\\bwhere\\s+)${pattern}\\s+and\\s+`, "i");
  const andThenPredicate = new RegExp(`\\s+and\\s+${pattern}`, "i");
  const onlyWhere = new RegExp(`(\\bwhere\\s+)${pattern}`, "i");

  return sql
    .replace(whereThenAnd, (_match, prefix) => prefix)
    .replace(andThenPredicate, "")
    .replace(onlyWhere, (_match, prefix) => `${prefix}1 = 1`);
}

function replaceLoose(sql, evidence, replacement) {
  if (!evidence) return sql;
  const pattern = new RegExp(loosePattern(evidence), "i");
  return sql.replace(pattern, replacement);
}

function loosePattern(text) {
  const tokens = tokenize(String(text || ""));
  if (tokens.length === 0) return escapeRegExp(String(text || ""));
  return tokens.map((token) => escapeRegExp(token.value)).join("\\s*");
}

function targetIdForEvidence(sourceModel, evidence, preferredKinds = []) {
  const normalized = normalizeEvidence(evidence);
  if (!normalized) return "";
  const candidates = sourceModel.traceLines.filter((entry) => normalizeEvidence(entry.text) === normalized);
  const match = candidates.find((entry) => preferredKinds.includes(entry.kind)) || candidates[0];
  return match?.id ?? "";
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = action.title === "Redact or justify the sensitive projection"
      ? action.title
      : `${action.id}:${normalizeEvidence(action.evidence)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredKindsFor(finding) {
  if (finding.title === "Sensitive field reaches the result set") return ["projection"];
  if (finding.title === "COUNT(*) occurs after joins") return ["projection"];
  if (finding.title.includes("LEFT JOIN") || finding.title.includes("NOT IN")) return ["where"];
  if (finding.title.includes("ORDER BY") || finding.title.includes("OFFSET")) return ["order"];
  return [];
}

function publicAction(action) {
  const { apply, applyInPlan, ...publicFields } = action;
  return publicFields;
}

function actionId(finding) {
  return `${finding.category}-${finding.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function flightActionIdentitySignature(action) {
  return {
    kind: "flight-action",
    title: action.title.toLowerCase(),
    category: action.category,
    severity: action.severity,
    evidence: canonicalClauseText(action.evidence || "")
  };
}

function normalizeEvidence(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function hashText(text) {
  let hash = 0;
  for (const char of String(text || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
