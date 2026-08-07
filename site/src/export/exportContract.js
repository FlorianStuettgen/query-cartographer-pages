import { canonicalizeJsonValue, serializeCanonicalJson } from "./canonicalJson.js";
import {
  IDENTITY_NAMESPACE,
  IDENTITY_SCHEMA_VERSION,
  canonicalClauseText,
  stableDigest
} from "../sql/identity.js";

export const CANONICAL_JSON_SCHEMA_ID = "query-cartographer.canonical-json-export";
export const CANONICAL_JSON_SCHEMA_VERSION = "1";
export const CANONICAL_JSON_CONTRACT_VERSION = "1.0.0";

const INPUT_ID_PREFIX = "q02b2a-v1-input-";
const ANALYSIS_ID_PREFIX = "q02b2a-v1-analysis-";
const HEX_64 = /^[0-9a-f]{16}$/;
const INPUT_ID = /^q02b2a-v1-input-[0-9a-f]{16}$/;
const ANALYSIS_ID = /^q02b2a-v1-analysis-[0-9a-f]{16}$/;
const SOURCE_ID = /^q02a-v1-source-model-[0-9a-f]{16}(?:-r(?:0[2-9]|[1-9][0-9]+))?$/;
const FINDING_ID = /^q02a-v1-finding-[0-9a-f]{16}(?:-r(?:0[2-9]|[1-9][0-9]+))?$/;
const METRIC_ID = /^q02a-v1-metric-[0-9a-f]{16}(?:-r(?:0[2-9]|[1-9][0-9]+))?$/;
const ACTION_ID = /^q02a-v1-flight-action-[0-9a-f]{16}(?:-r(?:0[2-9]|[1-9][0-9]+))?$/;
const STATES = new Set(["completed", "idle", "unsupported"]);
const TONES = new Set(["high", "info", "low", "medium"]);

const LIMITATIONS = [
  {
    code: "heuristic-analysis",
    detail: "Parser, dialect, row-flow, risk, and repair outputs are static heuristics rather than database-engine proof."
  },
  {
    code: "no-database-execution",
    detail: "The export records no query execution, database result, or production approval."
  },
  {
    code: "no-runtime-plan",
    detail: "Estimated rows and complexity do not replace EXPLAIN output or representative runtime validation."
  },
  {
    code: "review-only-actions",
    detail: "Repair actions and SQL previews require human review and do not guarantee semantic equivalence."
  }
];

export function buildCanonicalJsonExport(analysis, {
  contractVersion = CANONICAL_JSON_CONTRACT_VERSION
} = {}) {
  if (contractVersion !== CANONICAL_JSON_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported canonical JSON contract version: ${String(contractVersion)}`);
  }
  assertRecord(analysis, "analysis");
  assertRecord(analysis.ast, "analysis.ast");
  assertRecord(analysis.schema, "analysis.schema");
  assertRecord(analysis.sourceModel, "analysis.sourceModel");
  assertRecord(analysis.sourceModel.identity, "analysis.sourceModel.identity");

  const sql = requireString(analysis.ast.sql, "analysis.ast.sql");
  const schemaText = requireString(analysis.schema.raw, "analysis.schema.raw");
  const input = buildInputIdentity(sql, schemaText);
  const sourceEntries = requireArray(analysis.sourceModel.entries, "analysis.sourceModel.entries");
  const sourceIdentity = analysis.sourceModel.identity;
  const evidenceTargets = buildEvidenceTargetIndex(sourceEntries);

  const entities = sourceEntries.map((entry, index) => buildEntity(entry, index));
  const entityIds = new Set(entities.map(({ id }) => id));
  const routes = buildRoutes(sourceEntries, entityIds);
  const findings = requireArray(analysis.diagnosis?.findings, "analysis.diagnosis.findings")
    .map((finding, index) => buildFinding(finding, evidenceTargets, index));
  const metrics = requireArray(analysis.profile?.metrics, "analysis.profile.metrics")
    .map((metric, index) => buildMetric(metric, sourceIdentity, index));
  const actions = requireArray(analysis.flightPlan?.actions, "analysis.flightPlan.actions")
    .map((action, index) => buildAction(action, sourceIdentity, index));
  const flow = buildFlow(analysis.flow);
  const state = buildState(analysis);

  const body = canonicalizeSemanticCollections({
    actions,
    entities,
    findings,
    flow,
    limitations: LIMITATIONS,
    metrics,
    routes,
    state
  });
  const analysisId = expectedAnalysisId(input.id, body);

  return canonicalizeCanonicalJsonExport({
    schema: {
      id: CANONICAL_JSON_SCHEMA_ID,
      version: CANONICAL_JSON_SCHEMA_VERSION
    },
    contractVersion,
    analysis: {
      id: analysisId,
      inputId: input.id,
      engine: "query-cartographer",
      identityNamespace: IDENTITY_NAMESPACE,
      identityVersion: IDENTITY_SCHEMA_VERSION
    },
    input,
    ...body
  });
}

export function serializeCanonicalJsonExport(document) {
  return serializeCanonicalJson(canonicalizeCanonicalJsonExport(document));
}

export function validateCanonicalJsonExport(document) {
  canonicalizeCanonicalJsonExport(document);
  return true;
}

export function canonicalizeCanonicalJsonExport(document) {
  const normalized = canonicalizeJsonValue(document);
  validateDocumentShape(normalized);
  const body = canonicalizeSemanticCollections({
    actions: normalized.actions,
    entities: normalized.entities,
    findings: normalized.findings,
    flow: normalized.flow,
    limitations: normalized.limitations,
    metrics: normalized.metrics,
    routes: normalized.routes,
    state: normalized.state
  });
  const canonical = canonicalizeJsonValue({
    schema: normalized.schema,
    contractVersion: normalized.contractVersion,
    analysis: normalized.analysis,
    input: normalized.input,
    ...body
  });

  validateDocumentShape(canonical);
  validateCanonicalIdsAndReferences(canonical);
  const expectedId = expectedAnalysisId(canonical.input.id, body);
  if (canonical.analysis.id !== expectedId) {
    throw new TypeError(`Analysis identity does not match canonical content: expected ${expectedId}`);
  }
  return canonical;
}

function buildInputIdentity(sql, schemaText) {
  const schemaDigest = stableDigest(schemaText);
  const sqlDigest = stableDigest(sql);
  return {
    id: `${INPUT_ID_PREFIX}${stableDigest({ schemaDigest, sqlDigest })}`,
    digestAlgorithm: "fnv1a-64",
    schemaDigest,
    sqlDigest
  };
}

function buildEntity(entry, index) {
  const path = `analysis.sourceModel.entries[${index}]`;
  assertRecord(entry, path);
  const id = requireMatchingString(entry.stableId || entry.id, SOURCE_ID, `${path}.stableId`);
  if (entry.id && SOURCE_ID.test(entry.id) && entry.id !== id) {
    throw new TypeError(`${path}.id disagrees with its canonical stable ID`);
  }
  return {
    id,
    kind: requireNonEmptyString(entry.kind, `${path}.kind`),
    label: requireString(entry.label, `${path}.label`),
    text: requireString(entry.text, `${path}.text`)
  };
}

function buildRoutes(sourceEntries, entityIds) {
  const routes = [];
  const seen = new Set();
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const entry = sourceEntries[index];
    const toId = requireMatchingString(entry.stableId || entry.id, SOURCE_ID, `analysis.sourceModel.entries[${index}].stableId`);
    const predecessors = requireArray(entry.predecessors, `analysis.sourceModel.entries[${index}].predecessors`);
    for (let predecessorIndex = 0; predecessorIndex < predecessors.length; predecessorIndex += 1) {
      const fromId = requireMatchingString(
        predecessors[predecessorIndex],
        SOURCE_ID,
        `analysis.sourceModel.entries[${index}].predecessors[${predecessorIndex}]`
      );
      if (!entityIds.has(fromId)) {
        throw new TypeError(`Dangling route source: ${fromId}`);
      }
      const key = semanticKey(fromId, toId, "lineage");
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ fromId, toId, type: "lineage" });
    }
  }
  return routes;
}

function buildEvidenceTargetIndex(sourceEntries) {
  const byEvidence = new Map();
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const entry = sourceEntries[index];
    const id = requireMatchingString(entry.stableId || entry.id, SOURCE_ID, `analysis.sourceModel.entries[${index}].stableId`);
    const evidence = canonicalClauseText(requireString(entry.text, `analysis.sourceModel.entries[${index}].text`));
    if (!evidence) continue;
    byEvidence.set(evidence, [...(byEvidence.get(evidence) || []), id]);
  }
  for (const [key, values] of byEvidence) {
    byEvidence.set(key, [...new Set(values)].sort(compareCodeUnits));
  }
  return byEvidence;
}

function buildFinding(finding, evidenceTargets, index) {
  const path = `analysis.diagnosis.findings[${index}]`;
  assertRecord(finding, path);
  const evidence = requireString(finding.evidence, `${path}.evidence`);
  const evidenceKey = canonicalClauseText(evidence);
  return {
    id: requireMatchingString(finding.stableId, FINDING_ID, `${path}.stableId`),
    category: requireNonEmptyString(finding.category, `${path}.category`),
    severity: requireTone(finding.severity, `${path}.severity`),
    title: requireNonEmptyString(finding.title, `${path}.title`),
    detail: requireString(finding.detail, `${path}.detail`),
    evidence,
    suggestion: requireString(finding.suggestion, `${path}.suggestion`),
    targetIds: evidenceKey ? [...(evidenceTargets.get(evidenceKey) || [])] : []
  };
}

function buildMetric(metric, sourceIdentity, index) {
  const path = `analysis.profile.metrics[${index}]`;
  assertRecord(metric, path);
  const dependsOnIds = requireArray(metric.dependsOnIds, `${path}.dependsOnIds`)
    .map((candidate, candidateIndex) => (
      requireNonEmptyString(candidate, `${path}.dependsOnIds[${candidateIndex}]`)
    ));
  const sourceIds = requireArray(metric.sources, `${path}.sources`).map((source, sourceIndex) => {
    const sourcePath = `${path}.sources[${sourceIndex}]`;
    assertRecord(source, sourcePath);
    return requireNonEmptyString(source.sourceId, `${sourcePath}.sourceId`);
  });
  const candidateTargets = [
    ...dependsOnIds,
    ...sourceIds
  ];

  return {
    id: requireMatchingString(metric.stableId, METRIC_ID, `${path}.stableId`),
    label: requireNonEmptyString(metric.label, `${path}.label`),
    expression: requireString(metric.expression, `${path}.expression`),
    type: requireNonEmptyString(metric.type, `${path}.type`),
    grain: requireString(metric.grain, `${path}.grain`),
    tone: requireTone(metric.tone, `${path}.tone`),
    businessMeaning: requireString(metric.businessMeaning, `${path}.businessMeaning`),
    risk: requireString(metric.risk, `${path}.risk`),
    targetIds: resolveSourceReferences(candidateTargets, sourceIdentity, `${path}.targetIds`)
  };
}

function buildAction(action, sourceIdentity, index) {
  const path = `analysis.flightPlan.actions[${index}]`;
  assertRecord(action, path);
  const candidateTarget = requireNonEmptyString(action.targetId, `${path}.targetId`);
  return {
    id: requireMatchingString(action.stableId, ACTION_ID, `${path}.stableId`),
    rank: index + 1,
    category: requireNonEmptyString(action.category, `${path}.category`),
    severity: requireTone(action.severity, `${path}.severity`),
    title: requireNonEmptyString(action.title, `${path}.title`),
    maneuver: requireString(action.maneuver, `${path}.maneuver`),
    why: requireString(action.why, `${path}.why`),
    confidence: requireNonEmptyString(action.confidence, `${path}.confidence`),
    applied: requireBoolean(action.applied, `${path}.applied`),
    rowFactor: requireFiniteNumber(action.rowFactor, `${path}.rowFactor`),
    riskDelta: requireFiniteNumber(action.riskDelta, `${path}.riskDelta`),
    complexityDelta: requireFiniteNumber(action.complexityDelta, `${path}.complexityDelta`),
    previewSql: requireString(action.previewSql, `${path}.previewSql`),
    targetIds: resolveSourceReferences([candidateTarget], sourceIdentity, `${path}.targetIds`)
  };
}

function buildFlow(flow) {
  assertRecord(flow, "analysis.flow");
  return {
    summary: {
      blastRadius: requireFiniteNumber(flow.blastRadius, "analysis.flow.blastRadius"),
      complexity: requireFiniteNumber(flow.complexity, "analysis.flow.complexity"),
      finalRows: requireFiniteNumber(flow.finalRows, "analysis.flow.finalRows"),
      maxRows: requireFiniteNumber(flow.maxRows, "analysis.flow.maxRows")
    },
    stages: requireArray(flow.steps, "analysis.flow.steps").map((step, index) => {
      const path = `analysis.flow.steps[${index}]`;
      assertRecord(step, path);
      return {
        ordinal: index + 1,
        phase: requireNonEmptyString(step.phase, `${path}.phase`),
        label: requireString(step.label, `${path}.label`),
        beforeRows: requireFiniteNumber(step.beforeRows, `${path}.beforeRows`),
        afterRows: requireFiniteNumber(step.afterRows, `${path}.afterRows`),
        change: requireFiniteNumber(step.change, `${path}.change`),
        risk: requireTone(step.risk, `${path}.risk`),
        evidence: requireString(step.evidence, `${path}.evidence`),
        detail: requireString(step.detail, `${path}.detail`)
      };
    })
  };
}

function buildState(analysis) {
  const sql = requireString(analysis.ast.sql, "analysis.ast.sql");
  const status = sql.trim() === ""
    ? "idle"
    : analysis.ast.unsupported
      ? "unsupported"
      : "completed";
  return {
    status,
    riskLevel: requireTone(analysis.diagnosis?.riskLevel, "analysis.diagnosis.riskLevel"),
    score: requireFiniteNumber(analysis.diagnosis?.score, "analysis.diagnosis.score")
  };
}

function resolveSourceReferences(candidates, identity, path) {
  assertRecord(identity, `${path}.identity`);
  assertRecord(identity.legacyToStableGroups, `${path}.identity.legacyToStableGroups`);
  assertRecord(identity.stableToLegacy, `${path}.identity.stableToLegacy`);
  const resolved = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = requireNonEmptyString(candidates[index], `${path}[${index}]`);
    if (candidate !== candidate.trim()) {
      throw new TypeError(`${path}[${index}] is malformed: surrounding whitespace is not allowed`);
    }

    let canonicalId = "";
    if (SOURCE_ID.test(candidate)) {
      if (!hasOwn(identity.stableToLegacy, candidate)) {
        throw new TypeError(`Cannot resolve ${path}[${index}] '${candidate}': unknown canonical ID`);
      }
      canonicalId = candidate;
    } else {
      if (!hasOwn(identity.legacyToStableGroups, candidate)) {
        throw new TypeError(`Cannot resolve ${path}[${index}] '${candidate}': unknown legacy ID`);
      }
      const matches = identity.legacyToStableGroups[candidate];
      if (!Array.isArray(matches) || matches.length === 0) {
        throw new TypeError(`Cannot resolve ${path}[${index}] '${candidate}': unknown legacy ID`);
      }
      if (matches.length !== 1) {
        throw new TypeError(`Cannot resolve ${path}[${index}] '${candidate}': ambiguous legacy ID`);
      }
      canonicalId = matches[0];
    }

    resolved.push(requireMatchingString(canonicalId, SOURCE_ID, `${path}[${index}]`));
  }
  return [...new Set(resolved)].sort(compareCodeUnits);
}

function canonicalizeSemanticCollections(body) {
  return canonicalizeJsonValue({
    actions: body.actions.map((action) => ({
      ...action,
      targetIds: [...action.targetIds].sort(compareCodeUnits)
    })),
    entities: [...body.entities].sort(compareBy((entry) => entry.id)),
    findings: body.findings.map((finding) => ({
      ...finding,
      targetIds: [...finding.targetIds].sort(compareCodeUnits)
    })).sort(compareBy((entry) => entry.id)),
    flow: body.flow,
    limitations: [...body.limitations].sort(compareBy((entry) => entry.code)),
    metrics: body.metrics.map((metric) => ({
      ...metric,
      targetIds: [...metric.targetIds].sort(compareCodeUnits)
    })).sort(compareBy((entry) => entry.id)),
    routes: [...body.routes].sort(compareBy((route) => semanticKey(route.fromId, route.toId, route.type))),
    state: body.state
  });
}

function expectedAnalysisId(inputId, body) {
  return `${ANALYSIS_ID_PREFIX}${stableDigest({ inputId, ...body })}`;
}

function validateDocumentShape(document) {
  assertRecord(document, "export");
  assertExactKeys(document, [
    "actions", "analysis", "contractVersion", "entities", "findings", "flow",
    "input", "limitations", "metrics", "routes", "schema", "state"
  ], "export");
  assertRecord(document.schema, "export.schema");
  assertExactKeys(document.schema, ["id", "version"], "export.schema");
  if (document.schema.id !== CANONICAL_JSON_SCHEMA_ID) {
    throw new TypeError(`Unsupported canonical JSON schema: ${String(document.schema.id)}`);
  }
  if (document.schema.version !== CANONICAL_JSON_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported canonical JSON schema version: ${String(document.schema.version)}`);
  }
  if (document.contractVersion !== CANONICAL_JSON_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported canonical JSON contract version: ${String(document.contractVersion)}`);
  }

  assertRecord(document.analysis, "export.analysis");
  assertExactKeys(document.analysis, ["engine", "id", "identityNamespace", "identityVersion", "inputId"], "export.analysis");
  requireMatchingString(document.analysis.id, ANALYSIS_ID, "export.analysis.id");
  requireMatchingString(document.analysis.inputId, INPUT_ID, "export.analysis.inputId");
  if (document.analysis.engine !== "query-cartographer") throw new TypeError("export.analysis.engine is unsupported");
  if (document.analysis.identityNamespace !== IDENTITY_NAMESPACE) throw new TypeError("export.analysis.identityNamespace is unsupported");
  if (document.analysis.identityVersion !== IDENTITY_SCHEMA_VERSION) throw new TypeError("export.analysis.identityVersion is unsupported");

  assertRecord(document.input, "export.input");
  assertExactKeys(document.input, ["digestAlgorithm", "id", "schemaDigest", "sqlDigest"], "export.input");
  requireMatchingString(document.input.id, INPUT_ID, "export.input.id");
  if (document.analysis.inputId !== document.input.id) throw new TypeError("export.analysis.inputId does not match export.input.id");
  if (document.input.digestAlgorithm !== "fnv1a-64") throw new TypeError("export.input.digestAlgorithm is unsupported");
  requireMatchingString(document.input.schemaDigest, HEX_64, "export.input.schemaDigest");
  requireMatchingString(document.input.sqlDigest, HEX_64, "export.input.sqlDigest");
  const expectedInputId = `${INPUT_ID_PREFIX}${stableDigest({
    schemaDigest: document.input.schemaDigest,
    sqlDigest: document.input.sqlDigest
  })}`;
  if (document.input.id !== expectedInputId) throw new TypeError("export.input.id does not match its declared digests");

  validateStateShape(document.state);
  validateEntityShapes(document.entities);
  validateFindingShapes(document.findings);
  validateMetricShapes(document.metrics);
  validateRouteShapes(document.routes);
  validateActionShapes(document.actions);
  validateLimitationShapes(document.limitations);
  validateFlowShape(document.flow);
}

function validateStateShape(state) {
  assertRecord(state, "export.state");
  assertExactKeys(state, ["riskLevel", "score", "status"], "export.state");
  if (!STATES.has(state.status)) throw new TypeError(`export.state.status is unsupported: ${String(state.status)}`);
  requireTone(state.riskLevel, "export.state.riskLevel");
  requireFiniteNumber(state.score, "export.state.score");
}

function validateEntityShapes(entities) {
  requireArray(entities, "export.entities").forEach((entry, index) => {
    const path = `export.entities[${index}]`;
    assertRecord(entry, path);
    assertExactKeys(entry, ["id", "kind", "label", "text"], path);
    requireMatchingString(entry.id, SOURCE_ID, `${path}.id`);
    requireNonEmptyString(entry.kind, `${path}.kind`);
    requireString(entry.label, `${path}.label`);
    requireString(entry.text, `${path}.text`);
  });
}

function validateFindingShapes(findings) {
  requireArray(findings, "export.findings").forEach((finding, index) => {
    const path = `export.findings[${index}]`;
    assertRecord(finding, path);
    assertExactKeys(finding, ["category", "detail", "evidence", "id", "severity", "suggestion", "targetIds", "title"], path);
    requireMatchingString(finding.id, FINDING_ID, `${path}.id`);
    requireNonEmptyString(finding.category, `${path}.category`);
    requireTone(finding.severity, `${path}.severity`);
    requireNonEmptyString(finding.title, `${path}.title`);
    requireString(finding.detail, `${path}.detail`);
    requireString(finding.evidence, `${path}.evidence`);
    requireString(finding.suggestion, `${path}.suggestion`);
    validateTargetArray(finding.targetIds, `${path}.targetIds`);
  });
}

function validateMetricShapes(metrics) {
  requireArray(metrics, "export.metrics").forEach((metric, index) => {
    const path = `export.metrics[${index}]`;
    assertRecord(metric, path);
    assertExactKeys(metric, ["businessMeaning", "expression", "grain", "id", "label", "risk", "targetIds", "tone", "type"], path);
    requireMatchingString(metric.id, METRIC_ID, `${path}.id`);
    requireNonEmptyString(metric.label, `${path}.label`);
    requireString(metric.expression, `${path}.expression`);
    requireNonEmptyString(metric.type, `${path}.type`);
    requireString(metric.grain, `${path}.grain`);
    requireTone(metric.tone, `${path}.tone`);
    requireString(metric.businessMeaning, `${path}.businessMeaning`);
    requireString(metric.risk, `${path}.risk`);
    validateTargetArray(metric.targetIds, `${path}.targetIds`);
  });
}

function validateRouteShapes(routes) {
  requireArray(routes, "export.routes").forEach((route, index) => {
    const path = `export.routes[${index}]`;
    assertRecord(route, path);
    assertExactKeys(route, ["fromId", "toId", "type"], path);
    requireMatchingString(route.fromId, SOURCE_ID, `${path}.fromId`);
    requireMatchingString(route.toId, SOURCE_ID, `${path}.toId`);
    if (route.type !== "lineage") throw new TypeError(`${path}.type is unsupported`);
  });
}

function validateActionShapes(actions) {
  requireArray(actions, "export.actions").forEach((action, index) => {
    const path = `export.actions[${index}]`;
    assertRecord(action, path);
    assertExactKeys(action, [
      "applied", "category", "complexityDelta", "confidence", "id", "maneuver", "previewSql", "rank",
      "riskDelta", "rowFactor", "severity", "targetIds", "title", "why"
    ], path);
    requireMatchingString(action.id, ACTION_ID, `${path}.id`);
    requirePositiveInteger(action.rank, `${path}.rank`);
    if (action.rank !== index + 1) throw new TypeError(`${path}.rank must match its semantic array position`);
    requireNonEmptyString(action.category, `${path}.category`);
    requireTone(action.severity, `${path}.severity`);
    requireNonEmptyString(action.title, `${path}.title`);
    requireString(action.maneuver, `${path}.maneuver`);
    requireString(action.why, `${path}.why`);
    requireNonEmptyString(action.confidence, `${path}.confidence`);
    requireBoolean(action.applied, `${path}.applied`);
    requireFiniteNumber(action.rowFactor, `${path}.rowFactor`);
    requireFiniteNumber(action.riskDelta, `${path}.riskDelta`);
    requireFiniteNumber(action.complexityDelta, `${path}.complexityDelta`);
    requireString(action.previewSql, `${path}.previewSql`);
    validateTargetArray(action.targetIds, `${path}.targetIds`);
  });
}

function validateLimitationShapes(limitations) {
  requireArray(limitations, "export.limitations").forEach((limitation, index) => {
    const path = `export.limitations[${index}]`;
    assertRecord(limitation, path);
    assertExactKeys(limitation, ["code", "detail"], path);
    requireNonEmptyString(limitation.code, `${path}.code`);
    requireNonEmptyString(limitation.detail, `${path}.detail`);
  });
}

function validateFlowShape(flow) {
  assertRecord(flow, "export.flow");
  assertExactKeys(flow, ["stages", "summary"], "export.flow");
  assertRecord(flow.summary, "export.flow.summary");
  assertExactKeys(flow.summary, ["blastRadius", "complexity", "finalRows", "maxRows"], "export.flow.summary");
  for (const key of ["blastRadius", "complexity", "finalRows", "maxRows"]) {
    requireFiniteNumber(flow.summary[key], `export.flow.summary.${key}`);
  }
  requireArray(flow.stages, "export.flow.stages").forEach((stage, index) => {
    const path = `export.flow.stages[${index}]`;
    assertRecord(stage, path);
    assertExactKeys(stage, ["afterRows", "beforeRows", "change", "detail", "evidence", "label", "ordinal", "phase", "risk"], path);
    requirePositiveInteger(stage.ordinal, `${path}.ordinal`);
    if (stage.ordinal !== index + 1) throw new TypeError(`${path}.ordinal must match its semantic array position`);
    requireNonEmptyString(stage.phase, `${path}.phase`);
    requireString(stage.label, `${path}.label`);
    requireFiniteNumber(stage.beforeRows, `${path}.beforeRows`);
    requireFiniteNumber(stage.afterRows, `${path}.afterRows`);
    requireFiniteNumber(stage.change, `${path}.change`);
    requireTone(stage.risk, `${path}.risk`);
    requireString(stage.evidence, `${path}.evidence`);
    requireString(stage.detail, `${path}.detail`);
  });
}

function validateCanonicalIdsAndReferences(document) {
  const allIds = new Set();
  for (const collection of [document.entities, document.findings, document.metrics, document.actions]) {
    for (const entry of collection) {
      if (allIds.has(entry.id)) throw new TypeError(`Duplicate canonical ID: ${entry.id}`);
      allIds.add(entry.id);
    }
  }

  const entityIds = new Set(document.entities.map(({ id }) => id));
  for (const route of document.routes) {
    if (!entityIds.has(route.fromId)) throw new TypeError(`Dangling route source: ${route.fromId}`);
    if (!entityIds.has(route.toId)) throw new TypeError(`Dangling route target: ${route.toId}`);
  }
  rejectDuplicateKeys(document.routes, (route) => semanticKey(route.fromId, route.toId, route.type), "route");

  for (const [name, collection] of [
    ["finding", document.findings],
    ["metric", document.metrics],
    ["action", document.actions]
  ]) {
    for (const entry of collection) {
      for (const targetId of entry.targetIds) {
        if (!entityIds.has(targetId)) throw new TypeError(`Dangling ${name} target: ${targetId}`);
      }
      rejectDuplicateValues(entry.targetIds, `${name} ${entry.id} target`);
    }
  }
  rejectDuplicateKeys(document.limitations, ({ code }) => code, "limitation code");
  rejectDuplicateValues(document.actions.map(({ rank }) => rank), "action rank");
  rejectDuplicateValues(document.flow.stages.map(({ ordinal }) => ordinal), "flow ordinal");
}

function validateTargetArray(targetIds, path) {
  requireArray(targetIds, path).forEach((targetId, index) => {
    requireMatchingString(targetId, SOURCE_ID, `${path}[${index}]`);
  });
}

function rejectDuplicateKeys(values, getKey, label) {
  const seen = new Set();
  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) throw new TypeError(`Duplicate ${label}: ${String(key)}`);
    seen.add(key);
  }
}

function rejectDuplicateValues(values, label) {
  rejectDuplicateKeys(values, (value) => value, label);
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${path} has unsupported or missing fields: expected ${wanted.join(", ")}`);
  }
}

function assertRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireArray(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function requireNonEmptyString(value, path) {
  const result = requireString(value, path);
  if (result.trim() === "") throw new TypeError(`${path} must not be empty`);
  return result;
}

function requireMatchingString(value, pattern, path) {
  const result = requireString(value, path);
  if (!pattern.test(result)) throw new TypeError(`${path} is malformed: ${result}`);
  return result;
}

function requireTone(value, path) {
  const result = requireString(value, path);
  if (!TONES.has(result)) throw new TypeError(`${path} is unsupported: ${result}`);
  return result;
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function requireFiniteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requirePositiveInteger(value, path) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${path} must be a positive integer`);
  return value;
}

function semanticKey(...values) {
  return values.join("\u0000");
}

function compareBy(getKey) {
  return (left, right) => compareCodeUnits(getKey(left), getKey(right));
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
