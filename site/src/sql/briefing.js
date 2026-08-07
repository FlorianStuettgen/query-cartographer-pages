import { formatRows } from "./flow.js";

export function buildBriefing({ ast, schema, dialect, diagnosis, flow, flightPlan }) {
  const high = diagnosis.severityCounts.high ?? 0;
  const medium = diagnosis.severityCounts.medium ?? 0;
  const topFinding = diagnosis.findings.find((finding) => finding.severity === "high")
    || diagnosis.findings.find((finding) => finding.severity === "medium")
    || diagnosis.findings[0];
  const sourceNames = [...ast.sources, ...ast.joins.map((join) => join.source)]
    .map((source) => source.displayName || source.name)
    .filter(Boolean);
  const sensitiveColumns = sensitiveColumnNames(schema);
  const actionCount = flightPlan.actions.length;

  const disposition = high > 0
    ? { label: "Hold", tone: "high" }
    : medium > 0
      ? { label: "Review", tone: "medium" }
      : { label: "Ready", tone: "low" };

  const headline = high > 0
    ? `${high} high-risk issue${high === 1 ? "" : "s"} block a clean handoff`
    : medium > 0
      ? `${medium} medium-risk issue${medium === 1 ? "" : "s"} need owner review`
      : "No blocking static hazards detected";

  return {
    disposition,
    headline,
    readout: buildReadout({ disposition, topFinding, dialect, flow, actionCount }),
    facts: [
      { label: "Dialect", value: `${dialect.label}`, detail: `${dialect.confidence} confidence`, tone: dialect.confidence === "high" ? "low" : "medium" },
      { label: "Peak Rows", value: formatRows(flow.maxRows), detail: `${flow.blastRadius.toFixed(1)}x blast`, tone: flow.blastRadius >= 3 ? "medium" : "low" },
      { label: "Final Rows", value: formatRows(flow.finalRows), detail: `${flow.steps.length} modeled steps`, tone: "info" },
      { label: "Data Contract", value: sensitiveColumns.length ? `${sensitiveColumns.length} sensitive` : "No sensitive notes", detail: `${schema.tables.size} schema table${schema.tables.size === 1 ? "" : "s"}`, tone: sensitiveColumns.length ? "high" : "info" }
    ],
    narrative: buildNarrative({ topFinding, dialect, flow, sensitiveColumns, sourceNames, flightPlan }),
    nextActions: flightPlan.actions.slice(0, 4).map((action) => ({
      id: action.id,
      title: action.title,
      detail: action.maneuver,
      severity: action.severity,
      targetId: action.targetId,
      targetLabel: action.targetLabel,
      confidence: action.confidence
    })),
    assets: sourceNames.slice(0, 8),
    dialectSignals: dialect.signals.slice(0, 5),
    questions: buildQuestions({ ast, schema, diagnosis, dialect })
  };
}

function buildReadout({ disposition, topFinding, dialect, flow, actionCount }) {
  if (disposition.tone === "high") {
    return `${topFinding.title}. Treat this as ${articleFor(dialect.label)} ${dialect.label} review with ${formatRows(flow.maxRows)} modeled peak rows and ${actionCount} proposed repair maneuver${actionCount === 1 ? "" : "s"}.`;
  }

  if (disposition.tone === "medium") {
    return `${topFinding.title}. The query is close, but the review still needs evidence around grain, access paths, or dialect behavior.`;
  }

  return `The query has no blocking static findings. Validate the runtime plan and row counts before production use.`;
}

function buildNarrative({ topFinding, dialect, flow, sensitiveColumns, sourceNames, flightPlan }) {
  const lines = [];

  if (topFinding) {
    lines.push({
      label: "Primary concern",
      value: topFinding.title,
      detail: topFinding.suggestion || topFinding.detail,
      tone: topFinding.severity
    });
  }

  lines.push({
    label: "Engine read",
    value: `${dialect.label} / ${dialect.confidence}`,
    detail: dialect.signals.length ? dialect.signals.join(", ") : "No strong dialect-only syntax detected.",
    tone: dialect.confidence === "high" ? "low" : "medium"
  });

  lines.push({
    label: "Row movement",
    value: `${formatRows(flow.maxRows)} peak rows`,
    detail: `The model estimates ${flow.blastRadius.toFixed(1)}x expansion before the final ${formatRows(flow.finalRows)} rows.`,
    tone: flow.blastRadius >= 3 ? "medium" : "low"
  });

  lines.push({
    label: "Contract surface",
    value: sourceNames.length ? sourceNames.join(", ") : "No sources parsed",
    detail: sensitiveColumns.length ? `Sensitive columns noted: ${sensitiveColumns.slice(0, 4).join(", ")}` : "No sensitive columns were declared in schema notes.",
    tone: sensitiveColumns.length ? "high" : "info"
  });

  if (flightPlan.impact.beforeRisk > flightPlan.impact.afterRisk) {
    lines.push({
      label: "Repair leverage",
      value: `${flightPlan.impact.beforeRisk} -> ${flightPlan.impact.afterRisk} modeled risk`,
      detail: `${flightPlan.actions.length} local maneuver${flightPlan.actions.length === 1 ? "" : "s"} available; drafts are review-only and never executed.`,
      tone: "low"
    });
  }

  return lines;
}

function buildQuestions({ ast, schema, diagnosis, dialect }) {
  const questions = [];

  if (schema.tables.size === 0) {
    questions.push("Which table DDL and row counts should anchor the blast-radius model?");
  }

  if (diagnosis.findings.some((finding) => finding.title.includes("Sensitive field"))) {
    questions.push("Who is authorized to receive the sensitive projection?");
  }

  if (ast.joins.length > 0) {
    questions.push("What is the intended output grain after joins?");
  }

  if (dialect.confidence !== "high") {
    questions.push("Which SQL engine will execute this query?");
  }

  if (questions.length === 0) {
    questions.push("Does the database EXPLAIN plan agree with the modeled row flow?");
  }

  return questions.slice(0, 4);
}

function sensitiveColumnNames(schema) {
  const names = [];
  for (const table of schema.tables.values()) {
    for (const column of table.columns.values()) {
      if (column.sensitive) {
        names.push(`${table.displayName}.${column.displayName}`);
      }
    }
  }
  return names;
}

function articleFor(value) {
  return /^[aeiou]/i.test(String(value || "")) ? "an" : "a";
}
