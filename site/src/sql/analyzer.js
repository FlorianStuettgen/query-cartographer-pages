import { diagnose } from "./diagnostics.js";
import { detectDialect } from "./dialects.js";
import { buildBriefing } from "./briefing.js";
import { buildFlightPlan } from "./flightPlan.js";
import { buildFlow } from "./flow.js";
import { formatSqlWithLineMap } from "./formatter.js";
import { parseSql } from "./parser.js";
import { buildMarkdownReport, buildRewrite } from "./rewrites.js";
import { parseSchemaNotes } from "./schema.js";
import { buildSourceModel } from "./sourceModel.js";
import { buildReviewProfile } from "./reviewProfile.js";
import { IDENTITY_NAMESPACE, IDENTITY_SCHEMA_VERSION } from "./identity.js";
import { buildCanonicalJsonExport, serializeCanonicalJsonExport } from "../export/exportContract.js";
import { buildDeterministicMarkdownExport } from "../export/markdownContract.js";

export function analyzeQuery(sql, schemaText = "") {
  const schema = parseSchemaNotes(schemaText);
  const ast = parseSql(sql);
  const dialect = detectDialect(sql);
  const diagnosis = diagnose(ast, schema, dialect);
  const flow = buildFlow(ast, schema, diagnosis);
  const rewrite = buildRewrite(ast, diagnosis, flow);
  const { formattedSql, lineMap: formattedLineMap } = formatSqlWithLineMap(sql);
  const sourceModel = buildSourceModel(sql, ast, diagnosis, flow);
  const flightPlan = buildFlightPlan(ast, diagnosis, flow, sourceModel);
  const briefing = buildBriefing({ ast, schema, dialect, diagnosis, flow, flightPlan });
  const profile = buildReviewProfile({ ast, schema, dialect, diagnosis, flow, flightPlan, sourceModel });
  const report = buildMarkdownReport({ ast, schema, diagnosis, flow, rewrite, formattedSql, sourceModel, flightPlan, dialect, briefing });

  return {
    ast,
    schema,
    dialect,
    profile,
    briefing,
    diagnosis,
    flow,
    rewrite,
    flightPlan,
    report,
    formattedSql,
    formattedLineMap,
    sourceModel,
    metrics: buildMetrics(ast, schema, diagnosis, flow),
    identity: {
      namespace: IDENTITY_NAMESPACE,
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      sourceModel: sourceModel.identity,
      findings: diagnosis.identity,
      flightPlan: flightPlan.identity,
      profile: profile.identity
    }
  };
}

export function analyzeQueryToCanonicalJson(sql, schemaText = "", options = {}) {
  const analysis = analyzeQuery(sql, schemaText);
  return serializeCanonicalJsonExport(buildCanonicalJsonExport(analysis, options));
}

export function analyzeQueryToDeterministicMarkdown(sql, schemaText = "", options = {}) {
  return buildDeterministicMarkdownExport(analyzeQuery(sql, schemaText), options);
}

function buildMetrics(ast, schema, diagnosis, flow) {
  const sourceCount = ast.sources.length + ast.joins.length;
  const highFindings = diagnosis.severityCounts.high ?? 0;
  const mediumFindings = diagnosis.severityCounts.medium ?? 0;

  return [
    { label: "Risk", value: diagnosis.riskLevel, tone: diagnosis.riskLevel },
    { label: "Findings", value: String(diagnosis.findings.length), tone: highFindings ? "high" : mediumFindings ? "medium" : "low" },
    { label: "Sources", value: String(sourceCount), tone: sourceCount > 5 ? "medium" : "info" },
    { label: "Complexity", value: `${flow.complexity}/100`, tone: flow.complexity >= 70 ? "high" : flow.complexity >= 42 ? "medium" : "low" },
    { label: "Schema", value: String(schema.tables.size), tone: schema.tables.size ? "low" : "info" },
    { label: "Peak Rows", value: compactNumber(flow.maxRows), tone: flow.blastRadius >= 10 ? "high" : flow.blastRadius >= 3 ? "medium" : "low" },
    { label: "Final Rows", value: compactNumber(flow.finalRows), tone: "info" },
    { label: "Blast", value: `${flow.blastRadius.toFixed(1)}x`, tone: flow.blastRadius >= 10 ? "high" : flow.blastRadius >= 3 ? "medium" : "low" }
  ];
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(Math.round(value));
}
