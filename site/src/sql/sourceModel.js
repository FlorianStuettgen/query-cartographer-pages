import {
  IDENTITY_NAMESPACE,
  IDENTITY_SCHEMA_VERSION,
  attachStableIdentity,
  resolveRegistryId,
  canonicalClauseText,
  canonicalIdentifier
} from "./identity.js";

const CLAUSE_ORDER = ["cte", "source", "join", "where", "group", "having", "order", "limit", "projection"];

export function buildSourceModel(sql, ast, diagnosis, flow) {
  const rawLines = buildRawLines(sql);
  if (ast.unsupported) {
    return {
      rawLines,
      entries: [],
      traceLines: [],
      registry: new Map(),
      flowSignals: [],
      identity: attachStableIdentity([], {
        namespace: IDENTITY_NAMESPACE,
        schemaVersion: IDENTITY_SCHEMA_VERSION
      })
    };
  }

  const entries = [];
  const findingsByEvidence = indexFindings(diagnosis.findings);
  const cteIds = new Map(ast.ctes.map((cte, index) => [normalizeName(cte.name), `cte-${index}`]));
  const cteAssets = collectCteAssets(ast, cteIds);

  ast.ctes.forEach((cte, index) => {
    const relations = cteRelations(cte);
    entries.push(entry({
      id: `cte-${index}`,
      kind: "cte",
      label: `CTE ${cte.displayName}`,
      text: cte.sql || cte.displayName,
      span: cte.span,
      identity: {
        kind: "cte",
        cteName: canonicalIdentifier(cte.name),
        cteDisplayName: canonicalIdentifier(cte.displayName),
        statementText: canonicalClauseText(cte.sql || cte.displayName),
        relationCount: relations.length
      },
      predecessors: unique(relations.map((source) => (
        cteIds.get(normalizeName(source.name)) || cteAssets.get(normalizeName(source.name))?.id
      )).filter(Boolean))
    }));
  });

  for (const asset of cteAssets.values()) {
    entries.push(entry({
      id: asset.id,
      kind: "source",
      label: `SOURCE ${asset.source.displayName || asset.source.name}`,
      text: asset.source.displayName || asset.source.name,
      span: asset.source.span,
      identity: {
        kind: "source-asset",
        sourceRole: "asset",
        relation: canonicalIdentifier(asset.source.name),
        alias: canonicalIdentifier(asset.source.alias),
        sourceText: canonicalClauseText(asset.source.displayName || asset.source.name),
        sourceType: asset.source.type
      },
      descendants: [...asset.consumers]
    }));
  }

  ast.sources.forEach((source, index) => {
    entries.push(entry({
      id: `source-${index}`,
      kind: "source",
      label: `FROM ${source.alias || source.displayName || source.name}`,
      text: source.displayName || source.name,
      span: source.span,
      identity: {
        kind: "source-base",
        sourceRole: "base",
        relation: canonicalIdentifier(source.name),
        alias: canonicalIdentifier(source.alias),
        sourceText: canonicalClauseText(source.displayName || source.name),
        sourceType: source.type
      },
      predecessors: relationPredecessors(source, cteIds, cteAssets),
      descendants: ast.joins.length ? ["join-0"] : nextStageIds(ast)
    }));
  });

  ast.joins.forEach((join, index) => {
    const source = join.source;
    if (!source?.name) return;
    entries.push(entry({
      id: `join-source-${index}`,
      kind: "source",
      label: `SOURCE ${source.alias || source.displayName || source.name}`,
      text: source.displayName || source.name,
      span: source.span || join.span,
      identity: {
        kind: "source-join",
        sourceRole: "join",
        relation: canonicalIdentifier(source.name),
        alias: canonicalIdentifier(source.alias),
        sourceText: canonicalClauseText(source.displayName || source.name),
        sourceType: source.type,
        joinType: join.type
      },
      predecessors: relationPredecessors(source, cteIds, cteAssets),
      descendants: [`join-${index}`]
    }));
  });

  ast.joins.forEach((join, index) => {
    const previous = index === 0
      ? ast.sources.map((_, sourceIndex) => `source-${sourceIndex}`)
      : [`join-${index - 1}`];
    const joinSource = join.source?.name ? [`join-source-${index}`] : [];
    entries.push(entry({
      id: `join-${index}`,
      kind: "join",
      label: `${join.type.toUpperCase()} JOIN ${join.source.alias || join.source.displayName || join.source.name}`,
      text: join.condition || `${join.type.toUpperCase()} JOIN ${join.source.displayName || join.source.name}`,
      span: join.conditionSpan || join.span,
      identity: {
        kind: "join",
        joinType: join.type,
        relation: canonicalIdentifier(join.source?.name),
        relationAlias: canonicalIdentifier(join.source?.alias),
        condition: canonicalClauseText(join.condition || ""),
        sourceText: canonicalClauseText(join.source?.displayName || join.source?.name || "")
      },
      predecessors: [...previous, ...joinSource],
      descendants: index < ast.joins.length - 1 ? [`join-${index + 1}`] : nextStageIds(ast),
      severity: join.risky ? "high" : severityFor(join.condition, findingsByEvidence)
    }));
  });

  ast.predicates.forEach((predicate, index) => {
    entries.push(entry({
      id: `where-${index}`,
      kind: "where",
      label: `WHERE ${index + 1}`,
      text: predicate.text,
      span: predicate.span,
      identity: {
        kind: "predicate",
        clause: "where",
        text: canonicalClauseText(predicate.text)
      },
      predecessors: terminalJoinOrSource(ast),
      descendants: nextAfterWhere(ast),
      severity: severityFor(predicate.text, findingsByEvidence)
    }));
  });

  ast.groupBy.forEach((group, index) => {
    entries.push(entry({
      id: `group-${index}`,
      kind: "group",
      label: `GROUP BY ${index + 1}`,
      text: group.text,
      span: group.span,
      identity: {
        kind: "clause",
        clause: "group",
        text: canonicalClauseText(group.text)
      },
      predecessors: ast.predicates.length ? ast.predicates.map((_, whereIndex) => `where-${whereIndex}`) : terminalJoinOrSource(ast),
      descendants: ast.having.length ? ast.having.map((_, havingIndex) => `having-${havingIndex}`) : nextAfterGroup(ast),
      severity: severityFor(group.text, findingsByEvidence)
    }));
  });

  ast.having.forEach((predicate, index) => {
    entries.push(entry({
      id: `having-${index}`,
      kind: "having",
      label: `HAVING ${index + 1}`,
      text: predicate.text,
      span: predicate.span,
      identity: {
        kind: "clause",
        clause: "having",
        text: canonicalClauseText(predicate.text)
      },
      predecessors: ast.groupBy.length ? ast.groupBy.map((_, groupIndex) => `group-${groupIndex}`) : terminalJoinOrSource(ast),
      descendants: nextAfterHaving(ast),
      severity: severityFor(predicate.text, findingsByEvidence)
    }));
  });

  ast.orderBy.forEach((order, index) => {
    entries.push(entry({
      id: `order-${index}`,
      kind: "order",
      label: `ORDER BY ${index + 1}`,
      text: order.text,
      span: order.span,
      identity: {
        kind: "clause",
        clause: "order",
        text: canonicalClauseText(order.text)
      },
      predecessors: previousBeforeOrder(ast),
      descendants: ast.limit ? ["limit-0"] : ["result-0"],
      severity: severityFor(order.text, findingsByEvidence)
    }));
  });

  if (ast.limit) {
    entries.push(entry({
      id: "limit-0",
      kind: "limit",
      label: "LIMIT",
      text: ast.limit,
      span: null,
      identity: {
        kind: "clause",
        clause: "limit",
        text: canonicalClauseText(ast.limit)
      },
      predecessors: ast.orderBy.length ? ast.orderBy.map((_, orderIndex) => `order-${orderIndex}`) : previousBeforeOrder(ast),
      descendants: ["result-0"]
    }));
  }

  ast.projections.forEach((projection, index) => {
    entries.push(entry({
      id: `projection-${index}`,
      kind: "projection",
      label: projection.alias ? `SELECT ${projection.alias}` : `SELECT ${index + 1}`,
      text: projection.text,
      span: projection.span,
      identity: {
        kind: "projection",
        alias: canonicalIdentifier(projection.alias || ""),
        expression: canonicalClauseText(projection.text),
        aggregate: projection.aggregate,
        windowed: projection.windowed,
        isWildcard: projection.wildcard
      },
      predecessors: previousBeforeProjection(ast),
      descendants: ["result-0"],
      severity: severityFor(projection.text, findingsByEvidence)
    }));
  });

  entries.push(entry({
    id: "result-0",
    kind: "result",
    label: "RESULT",
    text: `${ast.projections.length} projection${ast.projections.length === 1 ? "" : "s"}`,
    span: null,
    identity: {
      kind: "result",
      projectionCount: ast.projections.length,
      sourceCount: ast.sources.length,
      joinCount: ast.joins.length,
      whereCount: ast.predicates.length,
      groupCount: ast.groupBy.length,
      havingCount: ast.having.length,
      orderCount: ast.orderBy.length,
      limitSet: Boolean(ast.limit)
    },
    predecessors: ast.projections.map((_, index) => `projection-${index}`)
  }));

  const identity = attachStableIdentity(entries.map((entry) => ({
    id: entry.id,
    kind: "source-model",
    signature: sourceModelIdentitySignature(entry),
    target: entry
  })), {
    namespace: IDENTITY_NAMESPACE,
    schemaVersion: IDENTITY_SCHEMA_VERSION
  });

  const registryEntries = toCanonicalEntries(entries, identity);
  const registry = wireRegistry(registryEntries);
  const traceLines = registryEntries
    .filter((item) => item.kind !== "result")
    .sort((a, b) => {
      const order = CLAUSE_ORDER.indexOf(a.kind) - CLAUSE_ORDER.indexOf(b.kind);
      if (order !== 0) return order;
      return (a.span?.lineStart ?? 9999) - (b.span?.lineStart ?? 9999);
    });

  const flowSignals = flow.steps.map((step, index) => ({
    id: `signal-${index}`,
    label: step.label,
    risk: step.risk,
    rowDelta: step.change,
    targetIds: canonicalizeTargetIds(inferFlowTargets(step, ast), identity)
  }));

  return {
    rawLines,
    entries: registryEntries,
    traceLines,
    registry,
    resultId: registryEntries.find((entry) => entry.kind === "result")?.id || "",
    flowSignals,
    identity
  };
}

function buildRawLines(sql) {
  let cursor = 0;
  return sql.split(/\r?\n/).map((text, index) => {
    const start = cursor;
    const end = start + text.length;
    cursor = end + 1;
    return { number: index + 1, text, start, end };
  });
}

function entry({ id, kind, label, text, span, predecessors = [], descendants = [], severity = "info", identity = null }) {
  return {
    id,
    kind,
    label,
    text,
    span,
    lineStart: span?.lineStart ?? null,
    lineEnd: span?.lineEnd ?? null,
    predecessors,
    descendants,
    severity,
    identity
  };
}

function canonicalizeTargetIds(values, identity) {
  return unique(resolveRegistryIds(values, identity));
}

function resolveRegistryIds(values, identity) {
  const canonical = [];
  for (const value of values) {
    const result = resolveRegistryId(value, identity);
    if (result.status === "resolved") canonical.push(result.canonicalId);
  }
  return canonical;
}

function toCanonicalEntries(entries, identity) {
  const output = [];

  for (const entry of entries) {
    const canonicalId = resolveRegistryId(entry.id, identity);
    if (!canonicalId || canonicalId.status !== "resolved") continue;
    const stableId = canonicalId.canonicalId;
    output.push({
      ...entry,
      id: stableId,
      legacyId: entry.id,
      predecessors: resolveRegistryIds(entry.predecessors, identity),
      descendants: resolveRegistryIds(entry.descendants, identity)
    });
  }

  return output;
}

function sourceModelIdentitySignature(entry) {
  const signature = {
    kind: entry.kind,
    label: canonicalClauseText(entry.label || ""),
    text: canonicalClauseText(entry.text || ""),
    severity: entry.severity,
    category: entry.identity?.kind
  };

  if (entry.identity && typeof entry.identity === "object") {
    signature.identity = entry.identity;
  }

  return signature;
}

function collectCteAssets(ast, cteIds) {
  const assets = new Map();

  ast.ctes.forEach((cte, cteIndex) => {
    for (const source of cteRelations(cte)) {
      const key = normalizeName(source.name);
      if (!key || cteIds.has(key)) continue;
      if (!assets.has(key)) {
        assets.set(key, {
          id: `asset-${assets.size}`,
          source,
          consumers: new Set()
        });
      }
      assets.get(key).consumers.add(`cte-${cteIndex}`);
    }
  });

  return assets;
}

function cteRelations(cte) {
  return [
    ...(cte.statement?.sources ?? []),
    ...(cte.statement?.joins ?? []).map((join) => join.source)
  ].filter((source) => source?.name);
}

function relationPredecessors(source, cteIds, cteAssets) {
  const key = normalizeName(source?.name);
  return [cteIds.get(key) || cteAssets.get(key)?.id].filter(Boolean);
}

function wireRegistry(entries) {
  const registry = new Map(entries.map((item) => [item.id, item]));

  for (const item of entries) {
    item.predecessors = unique(item.predecessors.filter((id) => registry.has(id) && id !== item.id));
    item.descendants = unique(item.descendants.filter((id) => registry.has(id) && id !== item.id));
  }

  for (const item of entries) {
    for (const predecessorId of item.predecessors) {
      const predecessor = registry.get(predecessorId);
      predecessor.descendants = unique([...predecessor.descendants, item.id]);
    }
    for (const descendantId of item.descendants) {
      const descendant = registry.get(descendantId);
      descendant.predecessors = unique([...descendant.predecessors, item.id]);
    }
  }

  return registry;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function unique(values) {
  return [...new Set(values)];
}

function indexFindings(findings) {
  const index = new Map();
  for (const finding of findings) {
    if (!finding.evidence) continue;
    const normalized = normalizeEvidence(finding.evidence);
    const current = index.get(normalized);
    if (!current || severityRank(finding.severity) > severityRank(current)) {
      index.set(normalized, finding.severity);
    }
  }
  return index;
}

function severityFor(text, findingsByEvidence) {
  const normalized = normalizeEvidence(text);
  return findingsByEvidence.get(normalized) ?? "info";
}

function normalizeEvidence(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function severityRank(severity) {
  return { info: 0, low: 1, medium: 2, high: 3 }[severity] ?? 0;
}

function terminalJoinOrSource(ast) {
  if (ast.joins.length > 0) return [`join-${ast.joins.length - 1}`];
  return ast.sources.map((_, index) => `source-${index}`);
}

function nextStageIds(ast) {
  if (ast.predicates.length) return ast.predicates.map((_, index) => `where-${index}`);
  if (ast.groupBy.length) return ast.groupBy.map((_, index) => `group-${index}`);
  if (ast.having.length) return ast.having.map((_, index) => `having-${index}`);
  if (ast.orderBy.length) return ast.orderBy.map((_, index) => `order-${index}`);
  if (ast.limit) return ["limit-0"];
  return ast.projections.length ? ast.projections.map((_, index) => `projection-${index}`) : ["result-0"];
}

function nextAfterWhere(ast) {
  if (ast.groupBy.length) return ast.groupBy.map((_, index) => `group-${index}`);
  if (ast.having.length) return ast.having.map((_, index) => `having-${index}`);
  if (ast.orderBy.length) return ast.orderBy.map((_, index) => `order-${index}`);
  if (ast.limit) return ["limit-0"];
  return ast.projections.map((_, index) => `projection-${index}`);
}

function nextAfterGroup(ast) {
  if (ast.orderBy.length) return ast.orderBy.map((_, index) => `order-${index}`);
  if (ast.limit) return ["limit-0"];
  return ast.projections.map((_, index) => `projection-${index}`);
}

function nextAfterHaving(ast) {
  if (ast.orderBy.length) return ast.orderBy.map((_, index) => `order-${index}`);
  if (ast.limit) return ["limit-0"];
  return ast.projections.map((_, index) => `projection-${index}`);
}

function previousBeforeOrder(ast) {
  if (ast.having.length) return ast.having.map((_, index) => `having-${index}`);
  if (ast.groupBy.length) return ast.groupBy.map((_, index) => `group-${index}`);
  if (ast.predicates.length) return ast.predicates.map((_, index) => `where-${index}`);
  return terminalJoinOrSource(ast);
}

function previousBeforeProjection(ast) {
  if (ast.limit) return ["limit-0"];
  if (ast.orderBy.length) return ast.orderBy.map((_, index) => `order-${index}`);
  if (ast.having.length) return ast.having.map((_, index) => `having-${index}`);
  if (ast.groupBy.length) return ast.groupBy.map((_, index) => `group-${index}`);
  if (ast.predicates.length) return ast.predicates.map((_, index) => `where-${index}`);
  return terminalJoinOrSource(ast);
}

function inferFlowTargets(step, ast) {
  if (step.phase === "from") return ast.sources.length ? ["source-0"] : [];
  if (step.phase === "join") {
    const index = ast.joins.findIndex((join) => step.label.includes(join.source.alias || join.source.displayName || join.source.name));
    return index >= 0 ? [`join-${index}`] : [];
  }
  if (step.phase === "where") return ast.predicates.map((_, index) => `where-${index}`);
  if (step.phase === "group") return ast.groupBy.map((_, index) => `group-${index}`);
  if (step.phase === "having") return ast.having.map((_, index) => `having-${index}`);
  if (step.phase === "order") return ast.orderBy.map((_, index) => `order-${index}`);
  if (step.phase === "limit") return ["limit-0"];
  return [];
}
