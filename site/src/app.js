import { analyzeQuery } from "./sql/analyzer.js";
import { buildLargeDemoSql, LARGE_DEMO_SCHEMA } from "./sql/demoModel.js";
import { formatRows } from "./sql/flow.js";
import { resolveRegistryId } from "./sql/identity.js";
import { renderLineageMap } from "./ui/diagram.js";
import {
  escapeCssString,
  escapeHtml,
  escapeHtmlAttribute,
  replaceTrustedMarkup,
  replaceWithTextState,
  safeClassToken,
  visibleText
} from "./security/browserBoundary.js";
import { createTheater } from "./ui/theater.js";
import { activateRegistryTarget, pulseSignal, renderTrace, selectRawSqlLines } from "./ui/trace.js";
import {
  BROWSER_DOWNLOAD_STATES,
  BROWSER_EXPORT_FORMATS,
  createBrowserExportHandler
} from "./export/browserExport.js";

window.__qcErrors = [];
window.addEventListener("error", (event) => {
  window.__qcErrors.push(event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.__qcErrors.push(String(event.reason));
});

const STORAGE_KEY = "query-cartographer-state-v1";
const THEME_KEY = "query-cartographer-theme-v2";
const LAYOUT_KEY = "query-cartographer-layout-v1";
const HISTORY_LIMIT = 80;
const SQL_KEYWORDS = new Set([
  "all",
  "and",
  "as",
  "between",
  "by",
  "case",
  "cross",
  "distinct",
  "else",
  "end",
  "except",
  "exists",
  "from",
  "full",
  "group",
  "having",
  "in",
  "inner",
  "intersect",
  "is",
  "join",
  "left",
  "like",
  "limit",
  "not",
  "null",
  "on",
  "or",
  "order",
  "outer",
  "over",
  "partition",
  "qualify",
  "right",
  "select",
  "then",
  "union",
  "using",
  "when",
  "where",
  "with"
]);

const elements = {
  sql: document.querySelector("#sql-input"),
  schema: document.querySelector("#schema-input"),
  status: document.querySelector("#analysis-status"),
  querySize: document.querySelector("#query-size"),
  schemaSize: document.querySelector("#schema-size"),
  lensCaption: document.querySelector("#lens-caption"),
  sample: document.querySelector("#sample-button"),
  analyze: document.querySelector("#analyze-button"),
  undo: document.querySelector("#undo-button"),
  redo: document.querySelector("#redo-button"),
  exportMarkdown: document.querySelector("#export-button"),
  exportJson: document.querySelector("#export-json-button"),
  clear: document.querySelector("#clear-button"),
  theme: document.querySelector("#theme-button"),
  utilityMenu: document.querySelector(".utility-menu"),
  emptyWorkspace: document.querySelector("#workspace-empty"),
  summary: document.querySelector("#summary-grid"),
  focus: document.querySelector("#focus-strip"),
  perspectiveSwitch: document.querySelector("#perspective-switch"),
  briefing: document.querySelector("#briefing-board"),
  inspect: document.querySelector("#inspect-board"),
  atlasNavigator: document.querySelector("#atlas-navigator"),
  atlasLayerSelect: document.querySelector("#atlas-layer-select"),
  atlasFilters: document.querySelector("#atlas-filters"),
  atlasVisibleCount: document.querySelector("#atlas-visible-count"),
  atlasCanvasWrap: document.querySelector(".atlas-canvas-wrap"),
  atlasEvidence: document.querySelector("#atlas-evidence-popover"),
  editorTabs: [...document.querySelectorAll("[data-editor-view]")],
  editorViews: [...document.querySelectorAll(".editor-view")],
  workspace: document.querySelector(".workspace"),
  workspaceResizer: document.querySelector("#workspace-resizer"),
  analysisRegion: document.querySelector(".analysis-region"),
  map: document.querySelector("#lineage-map"),
  mapCaption: document.querySelector("#map-caption"),
  theaterStage: document.querySelector("#theater-stage"),
  theaterCaption: document.querySelector("#theater-caption"),
  theaterToggle: document.querySelector("#theater-toggle-button"),
  theaterNodeLabel: document.querySelector("#theater-node-label"),
  theaterNodeLine: document.querySelector("#theater-node-line"),
  theaterNodeRisk: document.querySelector("#theater-node-risk"),
  flightCaption: document.querySelector("#flight-caption"),
  flightImpact: document.querySelector("#flight-impact"),
  flightActions: document.querySelector("#flight-actions"),
  flightDraft: document.querySelector("#flight-draft"),
  copyFlight: document.querySelector("#copy-flight-button"),
  trace: document.querySelector("#trace-list"),
  traceCaption: document.querySelector("#trace-caption"),
  formatted: document.querySelector("#formatted-output"),
  lensOverview: document.querySelector("#lens-overview"),
  lensMinimap: document.querySelector("#lens-minimap"),
  flow: document.querySelector("#flow-list"),
  flowCaption: document.querySelector("#flow-caption"),
  findings: document.querySelector("#findings-list"),
  findingsCaption: document.querySelector("#findings-caption"),
  rewrite: document.querySelector("#rewrite-output"),
  rewriteNotes: document.querySelector("#rewrite-notes"),
  copyFormatted: document.querySelector("#copy-formatted-button"),
  copyRewrite: document.querySelector("#copy-rewrite-button"),
  tabs: [...document.querySelectorAll(".modebar [role='tab']")],
  panels: [...document.querySelectorAll(".analysis-region > [role='tabpanel']")]
};

let currentAnalysis = null;
let analyzeTimer = 0;
let historyTimer = 0;
let editHistory = [];
let historyIndex = -1;
let restoringHistory = false;
let theater = null;
let selectedFlightActionId = "";
let selectedTargetId = "";
let atlasLayer = "risk";
let atlasFocusIds = [];
let atlasFocusMode = "perspective";
let renderedAtlasFocusIds = [];
let selectedPerspective = "decision";
let editorView = "lens";
let inspectorPreference = null;
let atlasEvidenceAnchor = null;
let atlasEvidenceOpen = false;
const perspectiveConfig = {
  decision: { label: "Decision", audienceKey: "manager", layer: "risk" },
  metrics: { label: "Metrics", audienceKey: "analyst", layer: "metrics" },
  debug: { label: "Debug", audienceKey: "engineer", layer: "lineage" }
};
const atlasFilters = {
  sources: true,
  joins: true,
  filters: true,
  grain: true,
  select: true
};

boot();

function boot() {
  applyTheme(readTheme());
  applySavedLayout();
  const saved = readSavedState();
  elements.sql.value = typeof saved.sql === "string" ? saved.sql : "";
  elements.schema.value = typeof saved.schema === "string" ? saved.schema : "";
  bindEvents();
  pushHistory("Initial query");
  analyze();
  activateEditorView(elements.sql.value.trim() ? "lens" : "source");
}

function bindEvents() {
  elements.sample.addEventListener("click", () => {
    commitHistorySnapshot("Before demo model");
    elements.sql.value = buildLargeDemoSql();
    elements.schema.value = LARGE_DEMO_SCHEMA;
    resetReviewContext();
    pushHistory("Loaded 1,506-line demo model");
    analyze({ revealEvidence: true });
    activateEditorView("lens");
  });

  elements.analyze.addEventListener("click", () => {
    analyze({ revealEvidence: true });
    activateEditorView("lens");
    activateTab("atlas");
  });
  elements.clear.addEventListener("click", () => {
    commitHistorySnapshot("Before reset");
    elements.sql.value = "";
    elements.schema.value = "";
    resetReviewContext();
    pushHistory("Reset workspace");
    analyze();
    activateEditorView("source");
  });

  elements.utilityMenu?.addEventListener("click", (event) => {
    if (event.target.closest("button")) elements.utilityMenu.open = false;
  });

  elements.exportMarkdown.addEventListener("click", createBrowserExportHandler({
    format: BROWSER_EXPORT_FORMATS.markdown,
    readSql: () => elements.sql.value,
    readSchema: () => elements.schema.value,
    downloadOptions: { onCleanupError: reportBrowserExportError },
    onSuccess: () => { elements.status.textContent = "Deterministic Markdown downloaded"; },
    onError: reportBrowserExportError
  }));
  elements.exportJson.addEventListener("click", createBrowserExportHandler({
    format: BROWSER_EXPORT_FORMATS.json,
    readSql: () => elements.sql.value,
    readSchema: () => elements.schema.value,
    downloadOptions: { onCleanupError: reportBrowserExportError },
    onSuccess: () => { elements.status.textContent = "Canonical JSON downloaded"; },
    onError: reportBrowserExportError
  }));
  elements.theme.addEventListener("click", toggleTheme);
  elements.undo.addEventListener("click", undoEdit);
  elements.redo.addEventListener("click", redoEdit);
  elements.copyRewrite?.addEventListener("click", copyRewriteSql);
  elements.copyFormatted?.addEventListener("click", copyFormattedSql);
  elements.copyFlight.addEventListener("click", copyFlightDraft);
  elements.theaterToggle?.addEventListener("click", toggleTheaterMode);

  elements.sql.addEventListener("input", scheduleAnalyze);
  elements.schema.addEventListener("input", scheduleAnalyze);
  elements.sql.addEventListener("input", scheduleHistorySnapshot);
  elements.schema.addEventListener("input", scheduleHistorySnapshot);
  document.addEventListener("keydown", handleHistoryShortcut);

  for (const tab of elements.editorTabs) {
    tab.addEventListener("click", () => activateEditorView(tab.dataset.editorView));
  }
  bindWorkspaceResizer();

  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => activateTab(tab.id.replace("tab-", "")));
  }

  elements.atlasLayerSelect.addEventListener("change", () => setAtlasLayer(elements.atlasLayerSelect.value));

  elements.atlasFilters.addEventListener("change", (event) => {
    const input = event.target.closest("[data-atlas-filter]");
    if (!input) return;
    setAtlasFilter(input.dataset.atlasFilter, input.checked);
  });

  document.addEventListener("click", (event) => {
    const closeEvidence = event.target.closest("[data-close-atlas-evidence]");
    if (closeEvidence) {
      hideAtlasEvidencePopover();
      return;
    }

    const minimize = event.target.closest("[data-minimize-card]");
    if (minimize) {
      const card = minimize.closest(".inspect-board");
      if (!card) return;
      inspectorPreference = !card.classList.contains("is-minimized");
      setInspectorCollapsed(inspectorPreference);
      return;
    }

    const perspective = event.target.closest("[data-perspective]");
    if (perspective) {
      setPerspectiveMode(perspective.dataset.perspective);
      return;
    }

    const lensLine = event.target.closest("[data-lens-line]");
    if (lensLine && currentAnalysis) {
      activateLensRow(lensLine);
      return;
    }

    const modeTarget = event.target.closest("[data-mode]");
    if (modeTarget) {
      activateTab(modeTarget.dataset.mode);
    }

    const atlasFocus = event.target.closest("[data-atlas-focus]");
    if (atlasFocus) {
      setAtlasFocus(atlasFocus.dataset.atlasFocus, atlasFocus.dataset.registryId);
      return;
    }

    const flightAction = event.target.closest("[data-flight-id]");
    if (flightAction) {
      selectFlightAction(flightAction.dataset.flightId);
      if (!flightAction.classList.contains("flight-card")) activateTab("fix");
      return;
    }

    const target = event.target.closest("[data-registry-id]");
    if (!target) return;
    activateSemanticTarget(target.dataset.registryId);
  });
}

function scheduleAnalyze() {
  window.clearTimeout(analyzeTimer);
  const sqlLines = elements.sql.value ? elements.sql.value.split(/\r?\n/).length : 0;
  elements.analyze.disabled = sqlLines === 0;
  elements.status.textContent = sqlLines
    ? `Reading ${sqlLines.toLocaleString()} line${sqlLines === 1 ? "" : "s"} locally...`
    : "Ready for SQL / local-only analysis";
  analyzeTimer = window.setTimeout(analyze, 180);
  updateInputCounters();
}

function scheduleHistorySnapshot() {
  if (restoringHistory) return;
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => pushHistory("Edited query"), 420);
}

function commitHistorySnapshot(label) {
  window.clearTimeout(historyTimer);
  pushHistory(label);
}

function pushHistory(label) {
  const snapshot = {
    sql: elements.sql.value,
    schema: elements.schema.value,
    label,
    at: Date.now()
  };
  const current = editHistory[historyIndex];
  if (current && current.sql === snapshot.sql && current.schema === snapshot.schema) {
    current.label = label || current.label;
    updateHistoryButtons();
    return;
  }
  editHistory = editHistory.slice(0, historyIndex + 1);
  editHistory.push(snapshot);
  if (editHistory.length > HISTORY_LIMIT) editHistory.shift();
  historyIndex = editHistory.length - 1;
  updateHistoryButtons();
}

function undoEdit() {
  commitHistorySnapshot("Before undo");
  if (historyIndex <= 0) return;
  restoreHistory(historyIndex - 1);
}

function redoEdit() {
  if (historyIndex >= editHistory.length - 1) return;
  restoreHistory(historyIndex + 1);
}

function restoreHistory(nextIndex) {
  const snapshot = editHistory[nextIndex];
  if (!snapshot) return;
  restoringHistory = true;
  historyIndex = nextIndex;
  elements.sql.value = snapshot.sql;
  elements.schema.value = snapshot.schema;
  restoringHistory = false;
  updateHistoryButtons();
  analyze();
  elements.status.textContent = `${snapshot.label || "Edit restored"} (${historyIndex + 1}/${editHistory.length})`;
}

function updateHistoryButtons() {
  elements.undo.disabled = historyIndex <= 0;
  elements.redo.disabled = historyIndex >= editHistory.length - 1;
}

function handleHistoryShortcut(event) {
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return;
  const key = event.key.toLowerCase();
  if (key === "z" && event.shiftKey) {
    event.preventDefault();
    redoEdit();
    return;
  }
  if (key === "z") {
    event.preventDefault();
    undoEdit();
    return;
  }
  if (key === "y") {
    event.preventDefault();
    redoEdit();
  }
}

function analyze({ revealEvidence = false } = {}) {
  const sql = elements.sql.value;
  const schema = elements.schema.value;
  currentAnalysis = analyzeQuery(sql, schema);
  if (!sql.trim()) {
    renderEmptyWorkspace();
    saveState(sql, schema);
    updateInputCounters();
    return;
  }

  showAnalysisWorkspace();
  selectedTargetId = pickInitialTarget(currentAnalysis);
  hideAtlasEvidencePopover();
  saveState(sql, schema);
  updateInputCounters();
  renderSummary(currentAnalysis);
  renderFocusStrip(currentAnalysis);
  renderBriefing(currentAnalysis);
  renderAtlasNavigator(currentAnalysis);
  renderLineageMap(elements.map, currentAnalysis);
  renderTheater(currentAnalysis);
  renderFlight(currentAnalysis);
  renderTrace(elements.trace, currentAnalysis);
  renderQueryLens(currentAnalysis);
  renderFlow(currentAnalysis);
  renderFindings(currentAnalysis);
  renderRewrite(currentAnalysis);
  renderInspectBoard(currentAnalysis, selectedTargetId);
  setInspectorCollapsed(inspectorPreference ?? true);
  highlightLensTarget(selectedTargetId);
  bindFlowSignals(currentAnalysis);
  updateCaptions(currentAnalysis);
  elements.status.textContent = visibleText(`${currentAnalysis.briefing.disposition.label}: ${currentAnalysis.briefing.headline}`);
  updateAtlasFilterButtons();
  updateAtlasLayerButtons();
  if (revealEvidence) renderAtlasEvidencePopover(currentAnalysis, selectedTargetId, { open: true });
}

function renderEmptyWorkspace() {
  document.body.classList.add("is-empty-workspace");
  elements.analysisRegion.classList.add("is-empty");
  elements.emptyWorkspace.hidden = false;
  elements.analyze.disabled = true;
  elements.status.textContent = "Ready for SQL / local-only analysis";
  elements.lensCaption.textContent = "Waiting for SQL";
  selectedTargetId = "";
  hideAtlasEvidencePopover();
  theater?.destroy();
  theater = null;
}

function showAnalysisWorkspace() {
  document.body.classList.remove("is-empty-workspace");
  elements.analysisRegion.classList.remove("is-empty");
  elements.emptyWorkspace.hidden = true;
  elements.analyze.disabled = false;
}

function resetReviewContext() {
  selectedPerspective = "decision";
  atlasLayer = perspectiveConfig.decision.layer;
  atlasFocusIds = [];
  atlasFocusMode = "perspective";
  selectedTargetId = "";
}

function renderSummary(analysis) {
  replaceTrustedMarkup(elements.summary, buildScorecards(analysis).map((card) => `
    <button
      class="metric risk-${safeClassToken(card.tone)}"
      type="button"
      title="${escapeHtmlAttribute(card.detail)}"
      ${card.mode ? `data-mode="${escapeHtmlAttribute(card.mode)}"` : ""}
      ${card.registryId ? `data-registry-id="${escapeHtmlAttribute(card.registryId)}"` : ""}
      ${card.flightId ? `data-flight-id="${escapeHtmlAttribute(card.flightId)}"` : ""}>
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <small>${escapeHtml(card.detail)}</small>
    </button>
  `).join(""));
}

function buildScorecards(analysis) {
  return analysis.profile.scorecards.map((card) => ({
    label: card.label,
    value: card.value,
    detail: card.detail,
    tone: card.tone,
    mode: card.mode,
    registryId: card.targetId,
    flightId: card.flightId
  }));
}

function renderFocusStrip(analysis) {
  if (!analysis) return;
  replaceTrustedMarkup(elements.perspectiveSwitch, Object.entries(perspectiveConfig).map(([perspective, config]) => `
    <button
      type="button"
      role="tab"
      data-perspective="${perspective}"
      aria-selected="${perspective === selectedPerspective}">
      ${config.label}
    </button>
  `).join(""));
}

function renderBriefing(analysis) {
  if (!analysis) return;
  const config = perspectiveConfig[selectedPerspective] || perspectiveConfig.decision;
  const audience = analysis.profile.audience[config.audienceKey] || analysis.profile.audience.manager;
  const hotspot = briefingHotspotForPerspective(analysis, selectedPerspective);
  replaceTrustedMarkup(elements.briefing, `
    <section class="briefing-copy risk-${safeClassToken(audience.tone)}">
      <span>${config.label} brief</span>
      <strong>${escapeHtml(audience.label)}</strong>
      <p>${escapeHtml(audience.detail)}</p>
    </section>
    ${hotspot ? `
      <button
        class="briefing-action risk-${safeClassToken(hotspot.tone)}"
        type="button"
        ${hotspot.targetId ? `data-registry-id="${escapeHtmlAttribute(hotspot.targetId)}"` : ""}
        ${hotspot.flightId ? `data-flight-id="${escapeHtmlAttribute(hotspot.flightId)}"` : ""}
        ${hotspot.kind === "fix" ? `data-mode="fix"` : ""}>
        <span>${escapeHtml(hotspot.prompt)}</span>
        <strong>${escapeHtml(hotspot.label)}</strong>
      </button>
    ` : ""}
  `);
}

function briefingHotspotForPerspective(analysis, perspective) {
  if (perspective === "metrics") {
    const finding = analysis.diagnosis.findings.find((candidate) => (
      /count|distinct|grain|group|window|projection|aggregate/i.test(candidate.title)
    ));
    if (finding) return hotspotFromFinding(analysis, finding, "Metric focus");
    const metric = analysis.profile.metrics.find((candidate) => ["high", "medium"].includes(candidate.tone))
      || analysis.profile.metrics[0];
    if (metric) {
      return {
        kind: "finding",
        prompt: "Metric focus",
        label: metric.risk || metric.label,
        tone: metric.tone,
        targetId: metric.id
      };
    }
  }

  if (perspective === "debug") {
    const finding = analysis.diagnosis.findings.find((candidate) => candidate.category === "syntax")
      || analysis.diagnosis.findings.find((candidate) => candidate.severity === "high")
      || analysis.diagnosis.findings[0];
    if (finding) return hotspotFromFinding(analysis, finding, "First break");
  }

  const hotspot = analysis.profile.hotspots[0];
  return hotspot ? { ...hotspot, prompt: "First action" } : null;
}

function hotspotFromFinding(analysis, finding, prompt) {
  return {
    kind: "finding",
    prompt,
    label: finding.title,
    tone: finding.severity,
    targetId: findRegistryIdForEvidence(analysis, finding.evidence)
  };
}

function setPerspectiveMode(perspective) {
  const config = perspectiveConfig[perspective];
  if (!config) return;
  selectedPerspective = perspective;
  atlasLayer = config.layer;
  atlasFocusIds = [];
  atlasFocusMode = "perspective";
  activateTab("atlas");
  renderFocusStrip(currentAnalysis);
  renderBriefing(currentAnalysis);
  renderAtlasNavigator(currentAnalysis);
  updateAtlasLayerButtons();
  renderTheater(currentAnalysis);
  renderAtlasEvidencePopover(currentAnalysis, selectedTargetId, { open: true });
  elements.status.textContent = perspectiveStatus(currentAnalysis, perspective);
}

function perspectiveStatus(analysis, perspective) {
  if (perspective === "metrics") {
    return visibleText(`Metrics view: ${analysis.profile.metrics.length} signals at ${analysis.profile.grain.label}`);
  }
  if (perspective === "debug") {
    return visibleText(`Debug view: ${analysis.sourceModel.entries.length} nodes / ${analysis.diagnosis.findings.length} findings / ${analysis.dialect.label}`);
  }
  return visibleText(`Decision view: ${analysis.briefing.headline}`);
}

function renderAtlasNavigator(analysis) {
  const riskRoutes = analysis.diagnosis.findings
    .map((finding) => {
      const id = findRegistryIdForEvidence(analysis, finding.evidence);
      return {
        id,
        label: finding.title,
        detail: finding.category,
        tone: finding.severity,
        focusIds: [id].filter(Boolean)
      };
    })
    .filter((route) => route.id)
    .slice(0, 4);
  const metricRoutes = analysis.profile.metrics.slice(0, 5).map((metric) => ({
    id: metric.id,
    label: metric.label,
    detail: metric.type,
    tone: metric.tone,
    focusIds: [metric.id, ...metric.dependsOnIds]
  }));
  const sourceRoutes = analysis.profile.sources.slice(0, 5).map((source) => ({
    id: source.id,
    label: source.alias || source.name,
    detail: `${formatRows(source.rows)} rows`,
    tone: source.tone,
    focusIds: [source.id]
  }));
  const actionRoutes = analysis.flightPlan.actions
    .filter((action) => action.targetId)
    .slice(0, 4)
    .map((action) => ({
      id: action.targetId,
      label: action.title,
      detail: `risk -${action.riskDelta}`,
      tone: action.severity,
      focusIds: [action.targetId]
    }));
  const clauseRoutes = analysis.sourceModel.traceLines
    .filter((entry) => ["join", "where", "group", "having", "order", "limit"].includes(entry.kind))
    .slice(0, 6)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      detail: entry.lineStart ? `raw line ${entry.lineStart}` : entry.kind,
      tone: entry.severity,
      focusIds: [entry.id, ...(entry.predecessors ?? []).slice(0, 3), ...(entry.descendants ?? []).slice(0, 3)]
    }));
  const grainRoutes = analysis.profile.grain.targetId ? [{
    id: analysis.profile.grain.targetId,
    label: analysis.profile.grain.label,
    detail: analysis.profile.grain.detail,
    tone: analysis.profile.grain.tone,
    focusIds: [analysis.profile.grain.targetId]
  }] : [];
  const stageRoutes = buildCteStageRoutes(analysis);

  const groups = selectedPerspective === "metrics"
    ? [["Metrics", metricRoutes], ["Grain", grainRoutes], ["Sources", sourceRoutes]]
    : selectedPerspective === "debug"
      ? [["Stages", stageRoutes], ["Risks", riskRoutes], ["Clauses", clauseRoutes], ["Sources", sourceRoutes]]
      : [["Decisions", riskRoutes], ["Actions", actionRoutes]];
  const routeCount = groups.reduce((total, [, routes]) => total + routes.length, 0);
  const perspectiveLabel = perspectiveConfig[selectedPerspective]?.label || "Decision";

  replaceTrustedMarkup(elements.atlasNavigator, `
    <summary>${perspectiveLabel} routes <span>${routeCount}</span></summary>
    <div class="atlas-route-menu">
      <button class="route-reset" type="button" data-atlas-focus="">Show full query</button>
      ${groups.map(([label, routes]) => renderRouteGroup(label, routes)).join("")}
    </div>
  `);
}

function renderRouteGroup(label, routes) {
  if (!routes.length) return "";
  return `
    <section class="route-group">
      <h3>${escapeHtml(label)}</h3>
      ${routes.map((route) => `
        <button
          class="route-chip risk-${safeClassToken(route.tone)}"
          type="button"
          data-atlas-focus="${escapeHtmlAttribute(route.focusIds.join(","))}"
          data-registry-id="${escapeHtmlAttribute(route.id)}">
          <strong>${escapeHtml(route.label)}</strong>
          <small>${escapeHtml(route.detail)}</small>
        </button>
      `).join("")}
    </section>
  `;
}

function buildCteStageRoutes(analysis) {
  const stages = analysis.sourceModel.entries.filter((entry) => entry.kind === "cte");
  if (!stages.length) return [];
  const chunkSize = stages.length > 80 ? 20 : stages.length > 36 ? 12 : 8;
  const routes = [];

  for (let index = 0; index < stages.length; index += chunkSize) {
    const chunk = stages.slice(index, index + chunkSize);
    const first = chunk[0];
    const last = chunk.at(-1);
    const focusIds = validRegistryIds(analysis, [
      ...first.predecessors,
      ...chunk.map((entry) => entry.id),
      ...last.descendants
    ]);
    routes.push({
      id: first.id,
      label: `${first.label.replace(/^CTE\s+/i, "")} - ${last.label.replace(/^CTE\s+/i, "")}`,
      detail: `${chunk.length} stages / lines ${first.lineStart || "?"}-${last.lineEnd || "?"}`,
      tone: "info",
      focusIds
    });
  }

  return routes.slice(0, 8);
}

function renderFlow(analysis) {
  if (analysis.flow.steps.length === 0) {
    replaceWithTextState(elements.flow, "No data motion modeled");
    return;
  }

  replaceTrustedMarkup(elements.flow, analysis.flow.steps.map((entry, index) => `
    <button class="flow-step risk-${safeClassToken(entry.risk)}" type="button" data-flow-index="${index}">
      <span class="step-index">${String(index + 1).padStart(2, "0")} ${escapeHtml(entry.phase)}</span>
      <strong>${escapeHtml(entry.label)}</strong>
      <small>${escapeHtml(formatRows(entry.beforeRows))} -> ${escapeHtml(formatRows(entry.afterRows))}</small>
    </button>
  `).join(""));
}

function renderFindings(analysis) {
  replaceTrustedMarkup(elements.findings, analysis.diagnosis.findings.map((entry) => {
    const registryId = findRegistryIdForEvidence(analysis, entry.evidence);
    return `
      <article class="finding risk-${safeClassToken(entry.severity)}" ${registryId ? `data-registry-id="${escapeHtmlAttribute(registryId)}"` : ""}>
        <div class="severity">${escapeHtml(entry.severity)} / ${escapeHtml(entry.category)}</div>
        <h3>${escapeHtml(entry.title)}</h3>
        <p>${escapeHtml(entry.detail)}</p>
        ${entry.evidence ? `<p><code>${escapeHtml(entry.evidence)}</code></p>` : ""}
        ${entry.suggestion ? `<p>${escapeHtml(entry.suggestion)}</p>` : ""}
      </article>
    `;
  }).join(""));
}

function renderFlight(analysis) {
  const plan = analysis.flightPlan;
  const actions = plan.actions;
  selectedFlightActionId = actions[0]?.id ?? "";

  replaceTrustedMarkup(elements.flightImpact, `
    ${renderImpactGauge("Risk", `${plan.impact.beforeRisk}`, `${plan.impact.afterRisk}`, "score")}
    ${renderImpactGauge("Complexity", `${plan.impact.beforeComplexity}`, `${plan.impact.afterComplexity}`, "score")}
    ${renderImpactGauge("Peak Rows", formatRows(plan.impact.beforePeakRows), formatRows(plan.impact.afterPeakRows), "rows")}
    ${renderImpactGauge("Avoided Rows", `${formatRows(plan.impact.rowsAvoided)} modeled`, "", "rows")}
  `);

  if (actions.length === 0) {
    replaceWithTextState(elements.flightActions, "No repair deck available");
    elements.flightDraft.textContent = visibleText(currentFlightDraftSql(analysis));
    return;
  }

  replaceTrustedMarkup(elements.flightActions, actions.map((action, index) => `
    <button
      class="flight-card risk-${safeClassToken(action.severity)} ${index === 0 ? "is-active" : ""}"
      type="button"
      data-flight-id="${escapeHtmlAttribute(action.id)}"
      ${action.targetId ? `data-registry-id="${escapeHtmlAttribute(action.targetId)}"` : ""}>
      <span class="flight-rank">${String(index + 1).padStart(2, "0")} ${escapeHtml(action.severity)}</span>
      <strong>${escapeHtml(action.title)}</strong>
      <span>${escapeHtml(action.maneuver)}</span>
      <small>
        ${action.targetLabel ? `${escapeHtml(action.targetLabel)} / ` : ""}
        risk -${escapeHtml(action.riskDelta)} / confidence ${escapeHtml(action.confidence)}
      </small>
    </button>
  `).join(""));

  elements.flightDraft.textContent = visibleText(currentFlightDraftSql(analysis));
}

function renderImpactGauge(label, before, after, kind) {
  const numericBefore = Number(before);
  const numericAfter = Number(after);
  const percent = Number.isFinite(numericBefore) && Number.isFinite(numericAfter) && numericBefore > 0
    ? Math.max(4, Math.min(100, (numericAfter / numericBefore) * 100))
    : 52;
  const value = after ? `${before} -> ${after}` : before;

  return `
    <article class="flight-gauge">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <i style="--gauge:${percent.toFixed(1)}%" data-kind="${safeClassToken(kind)}"></i>
    </article>
  `;
}

function selectFlightAction(actionId) {
  if (!currentAnalysis) return;
  const action = currentAnalysis.flightPlan.actions.find((entry) => entry.id === actionId);
  if (!action) return;

  selectedFlightActionId = action.id;
  elements.flightActions.querySelectorAll("[data-flight-id]").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.flightId === action.id);
  });

  if (action.targetId) activateSemanticTarget(action.targetId, { preserveMode: true });
  elements.flightDraft.textContent = visibleText(currentFlightDraftSql(currentAnalysis));
  elements.status.textContent = visibleText(`${action.title}: review draft ready`);
}

function renderRewrite(analysis) {
  elements.rewrite.textContent = visibleText(analysis.rewrite.sql || "");
  replaceTrustedMarkup(elements.rewriteNotes, analysis.rewrite.notes.map((entry) => `
    <article class="note">
      <h3>${escapeHtml(entry.title)}</h3>
      <p>${escapeHtml(entry.detail)}</p>
    </article>
  `).join(""));
}

function renderQueryLens(analysis) {
  const rows = buildLensRows(analysis);
  replaceTrustedMarkup(elements.formatted, rows.map(renderLensRow).join("") || renderLensRow({
    lineNumber: 1,
    rawLine: 1,
    text: "",
    targetId: "",
    scope: "",
    scopeLabel: "SQL",
    severity: "info",
    diagnostic: ""
  }));
  replaceTrustedMarkup(elements.lensMinimap, rows.map((row) => `
    <button
      class="lens-mini-line lens-risk-${safeClassToken(row.severity)}"
      type="button"
      title="${escapeHtmlAttribute(row.diagnostic || `${row.scopeLabel} line ${row.lineNumber}`)}"
      data-lens-line="${row.lineNumber}"
      data-raw-line="${row.rawLine || row.lineNumber}"
      ${row.targetId ? `data-registry-id="${escapeHtmlAttribute(row.targetId)}"` : ""}>
    </button>
  `).join(""));
  renderLensOverview(analysis, rows);
  elements.lensCaption.textContent = `${rows.length} lines`;
}

function lensText(analysis) {
  const hasSyntaxDamage = analysis.diagnosis.findings.some((finding) => finding.category === "syntax" && finding.severity === "high");
  return hasSyntaxDamage ? analysis.ast.sql : analysis.formattedSql;
}

function renderLensRow(row) {
  const title = [
    row.scopeLabel ? `${row.scopeLabel} scope` : "",
    row.rawLine ? `raw line ${row.rawLine}` : "",
    row.diagnostic
  ].filter(Boolean).join(" / ");

  return [
    `<span class="lens-line lens-risk-${safeClassToken(row.severity)}"`,
    ` data-lens-line="${row.lineNumber}"`,
    ` data-raw-line="${row.rawLine || row.lineNumber}"`,
    row.targetId ? ` data-registry-id="${escapeHtmlAttribute(row.targetId)}"` : "",
    ` title="${escapeHtmlAttribute(title)}">`,
    `<span class="lens-rail"><span class="lens-no">${String(row.lineNumber).padStart(4, " ")}</span><span class="lens-marker" aria-hidden="true"></span></span>`,
    `<span class="lens-scope">${escapeHtml(row.scope)}</span>`,
    `<code>${highlightSqlLine(row.text || " ")}</code>`,
    `</span>`
  ].join("");
}

function renderLensOverview(analysis, rows) {
  const highRows = rows.filter((row) => row.severity === "high").length;
  const riskRows = rows.filter((row) => ["high", "medium"].includes(row.severity)).length;
  const linkedRows = rows.filter((row) => row.targetId).length;
  const recovery = lensText(analysis) === analysis.ast.sql;

  replaceTrustedMarkup(elements.lensOverview, `
    <div class="lens-statusline">
      <span class="lens-state lens-risk-${safeClassToken(analysis.profile.posture.tone)}">${escapeHtml(analysis.profile.posture.label)}</span>
      <span>${highRows} blocking</span>
      <span>${Math.max(0, riskRows - highRows)} watch</span>
      <span>${linkedRows} linked</span>
      <span>${escapeHtml(analysis.dialect.label)}</span>
      <span>${recovery ? "Syntax recovery" : "Formatted model"}</span>
    </div>
  `);
}

function buildLensRows(analysis) {
  const lines = lensText(analysis).split(/\r?\n/);
  const entries = analysis.sourceModel.traceLines;
  const entriesByRawLine = new Map();

  for (const entry of entries) {
    const start = entry.lineStart ?? 0;
    const end = entry.lineEnd ?? start;
    for (let line = start; line <= end; line += 1) {
      const current = entriesByRawLine.get(line);
      if (!current || severityRank(entry.severity) > severityRank(current.severity)) {
        entriesByRawLine.set(line, entry);
      }
    }
  }

  let previousScope = "";
  return lines.map((text, index) => {
    const lineNumber = index + 1;
    const entry = entriesByRawLine.get(lineNumber) || findEntryForLensText(text, entries);
    const finding = findFindingForLensText(analysis, text)
      || (entry ? findFindingForEntry(analysis, entry) : null);
    const severity = maxSeverity(entry?.severity || "info", finding?.severity || "info");
    const scopeLabel = inferLensScope(text, entry);
    const scope = scopeLabel !== previousScope ? scopeLabel : "";
    previousScope = scopeLabel || previousScope;

    return {
      lineNumber,
      rawLine: entry?.lineStart || lineNumber,
      text,
      targetId: entry?.id || findRegistryIdForEvidence(analysis, finding?.evidence),
      scope,
      scopeLabel,
      severity,
      diagnostic: finding?.title || ""
    };
  });
}

function buildLensAnchors(analysis) {
  const preferred = ["cte", "source", "join", "where", "group", "having", "projection", "order", "limit"];
  const grouped = new Map(preferred.map((kind) => [kind, []]));
  for (const entry of analysis.sourceModel.traceLines) {
    if (!grouped.has(entry.kind)) grouped.set(entry.kind, []);
    grouped.get(entry.kind).push(entry);
  }

  return [...grouped.entries()].flatMap(([kind, entries]) => entries.slice(0, kind === "projection" ? 4 : 3).map((entry) => ({
    id: entry.id,
    kind: lensKindLabel(kind),
    label: entry.label.replace(/^(SELECT|WHERE|GROUP BY|ORDER BY)\s*/i, ""),
    severity: entry.severity
  })));
}

function findEntryForLensText(line, entries) {
  const normalized = normalizeEvidence(line);
  if (normalized.length < 3) return null;

  return entries.find((entry) => {
    const evidence = normalizeEvidence(entry.text);
    return evidence.length >= 4 && (normalized.includes(evidence) || evidence.includes(normalized));
  }) || null;
}

function findFindingForLensText(analysis, line) {
  const normalized = normalizeEvidence(line);
  if (normalized.length < 4) return null;
  return analysis.diagnosis.findings.find((finding) => {
    const evidence = normalizeEvidence(finding.evidence);
    return evidence.length >= 4 && (normalized.includes(evidence) || evidence.includes(normalized));
  }) || null;
}

function inferLensScope(line, entry) {
  if (entry?.kind) return lensKindLabel(entry.kind);
  const text = String(line || "").trim().toLowerCase();
  if (!text) return "";
  if (text.startsWith("with")) return "CTE";
  if (text.startsWith("select")) return "SELECT";
  if (text.startsWith("from")) return "FROM";
  if (text.includes(" join ")) return "JOIN";
  if (text.startsWith("where") || text.startsWith("and ") || text.startsWith("or ")) return "FILTER";
  if (text.startsWith("group by")) return "GRAIN";
  if (text.startsWith("having")) return "HAVING";
  if (text.startsWith("order by")) return "ORDER";
  if (text.startsWith("limit") || text.startsWith("offset")) return "BOUND";
  return "SQL";
}

function lensKindLabel(kind) {
  return {
    cte: "CTE",
    source: "FROM",
    join: "JOIN",
    where: "FILTER",
    group: "GRAIN",
    having: "HAVING",
    order: "ORDER",
    limit: "BOUND",
    projection: "SELECT",
    result: "RESULT"
  }[kind] || String(kind || "SQL").toUpperCase();
}

function activateLensRow(row) {
  const targetId = row.dataset.registryId;
  if (targetId) {
    activateSemanticTarget(targetId);
    return;
  }
  activateLineNumber(Number(row.dataset.rawLine || row.dataset.lensLine));
}

function highlightSqlLine(line) {
  const tokenPattern = /(--.*$|'(?:''|[^'])*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]+\]|\b\d+(?:\.\d+)?\b|\b[a-z_][\w$]*\b|[(),.*=<>+/-]+)/gi;
  let cursor = 0;
  let output = "";
  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    output += escapeHtml(line.slice(cursor, index));
    output += renderSqlToken(token, line.slice(index + token.length));
    cursor = index + token.length;
  }
  output += escapeHtml(line.slice(cursor));
  return output;
}

function renderSqlToken(token, rest) {
  if (token.startsWith("--")) return `<span class="tok-comment">${escapeHtml(token)}</span>`;
  if (/^'/.test(token)) return `<span class="tok-string">${escapeHtml(token)}</span>`;
  if (/^["`\[]/.test(token)) return `<span class="tok-identifier">${escapeHtml(token)}</span>`;
  if (/^\d/.test(token)) return `<span class="tok-number">${escapeHtml(token)}</span>`;
  if (/^[(),.*=<>+/-]+$/.test(token)) return `<span class="tok-operator">${escapeHtml(token)}</span>`;

  const lower = token.toLowerCase();
  if (SQL_KEYWORDS.has(lower)) {
    return `<span class="tok-keyword">${escapeHtml(token)}</span>`;
  }
  if (/^\s*\(/.test(rest)) {
    return `<span class="tok-function">${escapeHtml(token)}</span>`;
  }
  return `<span class="tok-identifier">${escapeHtml(token)}</span>`;
}

function updateCaptions(analysis) {
  const sourceCount = analysis.ast.sources.length + analysis.ast.joins.length;
  elements.mapCaption.textContent = `${sourceCount} sources, ${analysis.ast.joins.length} joins`;
  elements.theaterCaption.textContent = `${perspectiveConfig[selectedPerspective].label} / ${capitalize(atlasLayer)} / ${analysis.sourceModel.entries.length} nodes`;
  elements.flightCaption.textContent = `${analysis.flightPlan.actions.length} maneuver${analysis.flightPlan.actions.length === 1 ? "" : "s"}`;
  elements.traceCaption.textContent = `${analysis.sourceModel.traceLines.length} registry entries`;
  elements.flowCaption.textContent = `${formatRows(analysis.flow.maxRows)} peak rows`;
  elements.findingsCaption.textContent = `${analysis.diagnosis.findings.length} findings`;
}

function renderTheater(analysis) {
  theater?.destroy();
  const focusIds = atlasFocusMode === "route"
    ? atlasFocusIds
    : atlasFocusMode === "all"
      ? []
      : perspectiveFocusIds(analysis, selectedPerspective);
  renderedAtlasFocusIds = [...focusIds];
  theater = createTheater(elements.theaterStage, analysis, (targetId) => {
    activateSemanticTarget(targetId, { preserveMode: true });
  }, {
    layer: atlasLayer,
    filters: atlasFilters,
    focusIds,
    selectedId: selectedTargetId,
    perspective: selectedPerspective,
    showSelectionLabel: true,
    onSelectionAnchor: handleAtlasSelectionAnchor
  });
  if (!selectedTargetId) selectedTargetId = currentAnalysis?.sourceModel?.resultId || "";
  theater.select(selectedTargetId);
  const stats = theater.stats();
  const scope = stats.focused < stats.visible
    ? `${stats.focused} of ${stats.visible} nodes`
    : `${stats.visible} nodes`;
  elements.theaterCaption.textContent = `${perspectiveConfig[selectedPerspective].label} / ${capitalize(atlasLayer)} / ${scope}`;
  updateTheaterRail(selectedTargetId);
}

function perspectiveFocusIds(analysis, perspective) {
  if (perspective === "decision") {
    const findingTargets = analysis.diagnosis.findings
      .filter((finding) => ["high", "medium"].includes(finding.severity))
      .slice(0, 5)
      .map((finding) => findRegistryIdForEvidence(analysis, finding.evidence));
    const criticalTarget = findRegistryIdForEvidence(analysis, analysis.profile.criticalStep?.evidence);
    const seeds = validRegistryIds(analysis, [selectedTargetId, defaultTargetId(analysis), criticalTarget, ...findingTargets]);
    return expandRegistryNeighborhood(analysis, seeds, 10, 22);
  }
  if (perspective === "metrics") {
    const metricTargets = analysis.profile.metrics.slice(0, 8).flatMap((metric) => [metric.id, ...metric.dependsOnIds]);
    const seeds = validRegistryIds(analysis, [selectedTargetId, defaultTargetId(analysis), analysis.profile.grain.targetId, ...metricTargets]);
    return expandRegistryNeighborhood(analysis, seeds, 8, 32);
  }
  return [];
}

function validRegistryIds(analysis, ids) {
  const canonical = ids
    .map((id) => canonicalizeTargetId(analysis, id))
    .filter(Boolean);
  return [...new Set(canonical)];
}

function expandRegistryNeighborhood(analysis, seeds, maxDepth, limit) {
  const visited = new Set();
  const queue = seeds.map((id) => ({ id, depth: 0 }));

  while (queue.length && visited.size < limit) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    const entry = analysis.sourceModel.registry.get(current.id);
    if (!entry) continue;
    visited.add(current.id);
    if (current.depth >= maxDepth) continue;
    for (const id of [...(entry.predecessors ?? []), ...(entry.descendants ?? [])]) {
      if (!visited.has(id)) queue.push({ id, depth: current.depth + 1 });
    }
  }

  return [...visited];
}

function handleAtlasSelectionAnchor(anchor) {
  atlasEvidenceAnchor = anchor;
  if (atlasEvidenceOpen) positionAtlasEvidencePopover();
}

function positionAtlasEvidencePopover() {
  if (!atlasEvidenceOpen || elements.atlasEvidence.hidden) return;
  const wrapWidth = elements.atlasCanvasWrap.clientWidth;
  const wrapHeight = elements.atlasCanvasWrap.clientHeight;
  const popWidth = elements.atlasEvidence.offsetWidth;
  const popHeight = elements.atlasEvidence.offsetHeight;
  const anchor = atlasEvidenceAnchor || { x: wrapWidth / 2, y: wrapHeight / 2, radius: 18 };
  const placeLeft = anchor.x > wrapWidth * 0.56;
  const preferredLeft = placeLeft
    ? anchor.x - popWidth - anchor.radius - 18
    : anchor.x + anchor.radius + 18;
  const left = Math.max(12, Math.min(wrapWidth - popWidth - 12, preferredLeft));
  const top = Math.max(48, Math.min(wrapHeight - popHeight - 12, anchor.y - popHeight / 2));
  elements.atlasEvidence.style.left = `${Math.round(left)}px`;
  elements.atlasEvidence.style.top = `${Math.round(top)}px`;
  elements.atlasEvidence.classList.toggle("place-left", placeLeft);
}

function setAtlasLayer(layer) {
  atlasLayer = ["motion", "lineage", "risk", "metrics", "grain"].includes(layer) ? layer : "motion";
  updateAtlasLayerButtons();
  if (currentAnalysis) {
    renderTheater(currentAnalysis);
    elements.status.textContent = visibleText(`${capitalize(atlasLayer)} layer: ${currentAnalysis.briefing.headline}`);
  }
}

function updateAtlasLayerButtons() {
  elements.atlasLayerSelect.value = atlasLayer;
}

function setAtlasFilter(filter, enabled) {
  if (!(filter in atlasFilters)) return;
  atlasFilters[filter] = Boolean(enabled);
  updateAtlasFilterButtons();
  if (currentAnalysis) {
    renderTheater(currentAnalysis);
    elements.status.textContent = `${capitalize(filter)} ${atlasFilters[filter] ? "enabled" : "disabled"} in Atlas`;
  }
}

function setAtlasFocus(rawIds, primaryId = "") {
  atlasFocusIds = String(rawIds || "").split(",").filter(Boolean);
  atlasFocusMode = atlasFocusIds.length ? "route" : "all";
  if (atlasFocusIds.length && atlasLayer === "motion") {
    atlasLayer = "metrics";
    updateAtlasLayerButtons();
  }
  if (currentAnalysis) {
    renderTheater(currentAnalysis);
    if (primaryId) activateSemanticTarget(primaryId, { preserveMode: true });
    elements.status.textContent = atlasFocusIds.length
      ? `Atlas route isolated ${atlasFocusIds.length} semantic node${atlasFocusIds.length === 1 ? "" : "s"}`
      : "Atlas route reset to full query";
  }
}

function updateAtlasFilterButtons() {
  elements.atlasFilters.querySelectorAll("[data-atlas-filter]").forEach((input) => {
    input.checked = Boolean(atlasFilters[input.dataset.atlasFilter]);
  });
  const visible = Object.values(atlasFilters).filter(Boolean).length;
  elements.atlasVisibleCount.textContent = `${visible}/${Object.keys(atlasFilters).length}`;
}

function setInspectorCollapsed(collapsed) {
  const isCollapsed = Boolean(collapsed);
  elements.inspect.classList.toggle("is-minimized", isCollapsed);
  elements.theaterStage.classList.toggle("inspect-collapsed", isCollapsed);
  const button = elements.inspect.querySelector("[data-minimize-card]");
  button?.setAttribute("aria-label", isCollapsed ? "Expand inspector" : "Collapse inspector");
  window.setTimeout(() => theater?.resize(), 0);
}

function bindFlowSignals(analysis) {
  const steps = [...elements.flow.querySelectorAll(".flow-step")];
  steps.forEach((node, index) => {
    const signal = analysis.sourceModel.flowSignals[index];
    if (!signal) return;
    node.dataset.signalId = signal.id;
    node.addEventListener("mouseenter", () => pulseSignal(document, signal.targetIds));
    node.addEventListener("click", () => {
      pulseSignal(document, signal.targetIds);
      const targetId = canonicalizeTargetId(analysis, signal.targetIds[0]) || selectedTargetId;
      renderInspectBoard(analysis, targetId, { flowIndex: index });
      if (targetId) activateSemanticTarget(targetId, { preserveMode: true });
    });
  });
}

function renderAtlasEvidencePopover(analysis, targetId, options = {}) {
  if (!analysis) return;
  const canonicalTarget = canonicalizeTargetId(analysis, targetId) || defaultTargetId(analysis);
  const entry = canonicalTarget ? analysis.sourceModel.registry.get(canonicalTarget) : null;
  if (!entry) return;
  const finding = findContextFinding(analysis, entry);
  const action = findContextAction(analysis, entry, finding);
  const flowStep = findContextFlowStep(analysis, entry);
  const rows = buildPerspectiveEvidenceRows(analysis, entry, finding, action, flowStep);
  const config = perspectiveConfig[selectedPerspective] || perspectiveConfig.decision;
  const tone = finding?.severity || entry.severity || "info";
  const lineLabel = entry.lineStart ? `Raw line ${entry.lineStart}` : "Derived query node";

  elements.atlasEvidence.dataset.perspective = selectedPerspective;
  replaceTrustedMarkup(elements.atlasEvidence, `
    <header class="atlas-evidence-head risk-${safeClassToken(tone)}">
      <div>
        <span>${config.label} evidence</span>
        <strong>${escapeHtml(entry.label || "Query result")}</strong>
        <small>${escapeHtml(`${lineLabel} / ${entry.kind}`)}</small>
      </div>
      <button type="button" data-close-atlas-evidence aria-label="Close evidence popup">&times;</button>
    </header>
    <div class="atlas-evidence-body">
      ${rows.map(renderAtlasEvidenceRow).join("")}
    </div>
    <footer class="atlas-evidence-actions">
      <button type="button" data-mode="inspect">Full evidence</button>
      ${action ? `<button type="button" class="primary" data-mode="fix">Repair plan</button>` : ""}
    </footer>
  `);
  atlasEvidenceOpen = options.open !== false;
  elements.atlasEvidence.hidden = !atlasEvidenceOpen;
  if (atlasEvidenceOpen) window.requestAnimationFrame(positionAtlasEvidencePopover);
}

function buildPerspectiveEvidenceRows(analysis, entry, finding, action, flowStep) {
  const predecessors = entry.predecessors?.length ?? 0;
  const descendants = entry.descendants?.length ?? 0;
  const predecessorLabels = labelTargets(analysis, entry.predecessors ?? []);
  const descendantLabels = labelTargets(analysis, entry.descendants ?? []);

  if (selectedPerspective === "metrics") {
    const metrics = metricsForSelection(analysis, entry).slice(0, 2);
    const sources = sourcesForSelection(analysis, entry, metrics).slice(0, 4);
    const metric = metrics[0];
    return [
      {
        label: "Output meaning",
        value: metrics.map((item) => item.label).join(", ") || "No metric output attached",
        detail: metric?.businessMeaning || "This node shapes logic but does not directly emit a metric."
      },
      {
        label: "Business grain",
        value: analysis.profile.grain.label,
        detail: analysis.profile.grain.detail
      },
      {
        label: "Source path",
        value: sources.map((source) => source.alias || source.name).join(" -> ") || `${predecessors} inputs / ${descendants} outputs`,
        detail: `${predecessorLabels.join(", ") || "query start"} -> ${descendantLabels.join(", ") || "result"}`
      },
      {
        label: "Data motion",
        value: flowStep ? `${formatRows(flowStep.beforeRows)} -> ${formatRows(flowStep.afterRows)}` : "No matched row step",
        detail: flowStep?.detail || "Validate row counts at runtime for this logic boundary."
      }
    ];
  }

  if (selectedPerspective === "debug") {
    return [
      {
        label: "Source evidence",
        value: entry.lineStart ? `Line ${entry.lineStart}` : entry.kind,
        detail: compactText(finding?.evidence || entry.text || entry.label, 180),
        code: true
      },
      {
        label: "Diagnostic",
        value: finding?.title || "No direct static finding",
        detail: finding?.detail || "This node is available for structural tracing."
      },
      {
        label: "Dependency path",
        value: `${predecessors} in / ${descendants} out`,
        detail: `${predecessorLabels.join(", ") || "query start"} -> ${descendantLabels.join(", ") || "result"}`
      },
      {
        label: "Repair",
        value: action?.title || finding?.suggestion || "Validate with EXPLAIN",
        detail: action?.maneuver || finding?.detail || "Compare this static path with representative runtime plans."
      }
    ];
  }

  const blocksHandoff = finding?.severity === "high";
  const contract = analysis.profile.contract;
  const impactStep = flowStep || analysis.profile.criticalStep;
  return [
    {
      label: "Handoff decision",
      value: blocksHandoff ? "Blocks handoff" : finding ? "Needs review" : analysis.profile.posture.label,
      detail: finding?.title || analysis.profile.posture.reason
    },
    {
      label: "Business exposure",
      value: `${contract.value} contract / ${formatRows(analysis.flow.maxRows)} peak`,
      detail: contract.detail
    },
    {
      label: "Largest consequence",
      value: impactStep ? `${formatRows(impactStep.beforeRows)} -> ${formatRows(impactStep.afterRows)}` : "Runtime validation required",
      detail: impactStep?.label || analysis.briefing.headline
    },
    {
      label: "Next owner action",
      value: action?.title || finding?.suggestion || "Assign validation",
      detail: action?.maneuver || finding?.detail || "Confirm the result contract before release."
    }
  ];
}

function renderAtlasEvidenceRow(row) {
  return `
    <section class="atlas-evidence-row">
      <span>${escapeHtml(row.label)}</span>
      <strong>${escapeHtml(compactText(row.value, 110))}</strong>
      ${row.code
        ? `<code>${escapeHtml(compactText(row.detail, 180))}</code>`
        : `<p>${escapeHtml(compactText(row.detail, 190))}</p>`}
    </section>
  `;
}

function hideAtlasEvidencePopover() {
  atlasEvidenceOpen = false;
  elements.atlasEvidence.hidden = true;
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function findContextFinding(analysis, entry) {
  const text = normalizeEvidence(entry?.text);
  const exact = analysis.diagnosis.findings.find((finding) => normalizeEvidence(finding.evidence) === text);
  if (exact) return exact;
  if (entry?.kind === "result") return analysis.diagnosis.findings[0] || null;
  return analysis.diagnosis.findings.find((finding) => {
    const evidence = normalizeEvidence(finding.evidence);
    return text.length >= 4 && evidence.length >= 4 && (text.includes(evidence) || evidence.includes(text));
  }) || null;
}

function findContextAction(analysis, entry, finding) {
  const evidence = normalizeEvidence(finding?.evidence);
  const exact = evidence
    ? analysis.flightPlan.actions.find((action) => normalizeEvidence(action.evidence) === evidence)
    : null;
  if (exact) return exact;
  if (finding && finding.severity !== "info") return null;
  return analysis.flightPlan.actions.find((action) => action.targetId === entry?.id)
    || (entry?.kind === "result" ? analysis.flightPlan.actions[0] : null);
}

function findContextFlowStep(analysis, entry) {
  const text = normalizeEvidence(entry?.text);
  return analysis.flow.steps.find((step) => normalizeEvidence(step.evidence) === text)
    || analysis.flow.steps.find((step) => step.phase === entry?.kind)
    || (entry?.kind === "result" ? analysis.flow.steps.at(-1) : null);
}

function activateSemanticTarget(targetId, options = {}) {
  if (!currentAnalysis) return;
  const canonicalTargetId = canonicalizeTargetId(currentAnalysis, targetId);
  if (!canonicalTargetId) return;
  selectedTargetId = canonicalTargetId;
  const related = activateRegistryTarget(document, canonicalTargetId, currentAnalysis.sourceModel);
  selectRawSqlLines(elements.sql, currentAnalysis.sourceModel, canonicalTargetId);
  const atlasVisible = !document.querySelector("#view-atlas")?.hidden;
  if (atlasVisible) ensureAtlasTargetVisible(currentAnalysis, canonicalTargetId);
  theater?.select(canonicalTargetId);
  updateTheaterRail(canonicalTargetId);
  renderInspectBoard(currentAnalysis, canonicalTargetId);
  if (atlasVisible) {
    renderAtlasEvidencePopover(currentAnalysis, canonicalTargetId, { open: true });
  } else {
    setInspectorCollapsed(false);
    hideAtlasEvidencePopover();
  }
  highlightLensTarget(canonicalTargetId);
  const active = currentAnalysis.sourceModel.registry.get(canonicalTargetId);
  if (active) {
    elements.status.textContent = visibleText(`${active.label}: ${active.lineStart ? `raw line ${active.lineStart}` : "derived node"} (${related.length} linked)`);
  }
  if (!options.preserveMode && document.querySelector("#view-atlas")?.hidden) activateTab("inspect");
}

function ensureAtlasTargetVisible(analysis, targetId) {
  const canonicalTarget = canonicalizeTargetId(analysis, targetId) || defaultTargetId(analysis);
  if (!canonicalTarget) return;
  if (!renderedAtlasFocusIds.length || renderedAtlasFocusIds.includes(canonicalTarget)) return;
  atlasFocusIds = expandRegistryNeighborhood(analysis, [canonicalTarget], 5, 24);
  atlasFocusMode = "route";
  renderTheater(analysis);
}

function renderInspectBoard(analysis, targetId, options = {}) {
  const canonicalTarget = canonicalizeTargetId(analysis, targetId) || defaultTargetId(analysis);
  const entry = canonicalTarget ? analysis.sourceModel.registry.get(canonicalTarget) : null;
  const finding = entry ? findContextFinding(analysis, entry) : analysis.diagnosis.findings[0];
  const action = entry ? findContextAction(analysis, entry, finding) : analysis.flightPlan.actions[0];
  const flowStep = Number.isInteger(options.flowIndex)
    ? analysis.flow.steps[options.flowIndex]
    : findFlowStepForEntry(analysis, entry);
  const predecessors = entry?.predecessors?.length ?? 0;
  const descendants = entry?.descendants?.length ?? 0;
  const relatedMetrics = metricsForSelection(analysis, entry).slice(0, 4);
  const relatedSources = sourcesForSelection(analysis, entry, relatedMetrics).slice(0, 6);
  const predecessorLabels = labelTargets(analysis, entry?.predecessors ?? []);
  const descendantLabels = labelTargets(analysis, entry?.descendants ?? []);
  const inspectorToggleLabel = elements.inspect.classList.contains("is-minimized")
    ? "Expand inspector"
    : "Collapse inspector";

  replaceTrustedMarkup(elements.inspect, `
    <div class="card-minibar">
      <span>Inspect</span>
      <button type="button" data-minimize-card aria-label="${escapeHtmlAttribute(inspectorToggleLabel)}">&#8250;</button>
    </div>
    <section class="inspect-head risk-${safeClassToken(entry?.severity || finding?.severity || "info")}">
      <span>${escapeHtml(entry?.kind || "result")}</span>
      <h3>${escapeHtml(entry?.label || "Result")}</h3>
      <p>${escapeHtml(entry?.lineStart ? `Raw line ${entry.lineStart}` : "Derived from the query model")}</p>
    </section>
    <section class="inspect-facts">
      <article>
        <span>Lineage</span>
        <strong>${predecessors} in / ${descendants} out</strong>
        <p>${escapeHtml(predecessorLabels.length || descendantLabels.length
          ? `${predecessorLabels.join(", ") || "query start"} -> ${descendantLabels.join(", ") || "result"}`
          : entry?.text || "Final query result")}</p>
      </article>
      <article>
        <span>Data Motion</span>
        <strong>${escapeHtml(flowStep ? `${formatRows(flowStep.beforeRows)} -> ${formatRows(flowStep.afterRows)}` : "No row step")}</strong>
        <p>${escapeHtml(flowStep?.detail || "No clause-level row movement matched this selection.")}</p>
      </article>
    </section>
    <section class="inspect-guidance">
      <article>
        <span>Diagnostic</span>
        <strong>${escapeHtml(finding?.title || "No finding attached")}</strong>
        <p>${escapeHtml(finding?.suggestion || finding?.detail || "Selection has no blocking static issue.")}</p>
      </article>
      <article>
        <span>Repair</span>
        <strong>${escapeHtml(action?.title || "Validate runtime plan")}</strong>
        <p>${escapeHtml(action?.maneuver || "Compare this static atlas against representative EXPLAIN output.")}</p>
      </article>
    </section>
    <details class="inspect-rollup" open>
      <summary class="inspect-section-head">
        <span>Source Inventory</span>
        <strong>${relatedSources.length}/${analysis.profile.sources.length}</strong>
      </summary>
      <div class="source-list">
        ${relatedSources.map(renderSourceChip).join("") || `<div class="empty-compact">No source inventory for this selection.</div>`}
      </div>
    </details>
    <details class="inspect-rollup" ${entry?.kind === "projection" ? "open" : ""}>
      <summary class="inspect-section-head">
        <span>Metric ETL Lineage</span>
        <strong>${relatedMetrics.length}/${analysis.profile.metrics.length}</strong>
      </summary>
      <div class="metric-lineage-list">
        ${relatedMetrics.map(renderMetricLineageCard).join("") || `<div class="empty-compact">No metric-style projection is attached here.</div>`}
      </div>
    </details>
    <details class="inspect-rollup questions-strip">
      <summary class="inspect-section-head">
        <span>Review Questions</span>
        <strong>${Math.min(3, analysis.profile.questions.length)}</strong>
      </summary>
      ${analysis.profile.questions.slice(0, 3).map((question) => `<p>${escapeHtml(question)}</p>`).join("")}
    </details>
  `);
}

function renderSourceChip(source) {
  const name = source.alias ? `${source.name} as ${source.alias}` : source.name;
  return `
    <button class="source-chip risk-${safeClassToken(source.tone)}" type="button" data-registry-id="${escapeHtmlAttribute(source.id)}">
      <span>${escapeHtml(source.role)}</span>
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(formatRows(source.rows))} rows / ${escapeHtml(source.schemaStatus)} / ${escapeHtml(source.detail)}</small>
    </button>
  `;
}

function renderMetricLineageCard(metric) {
  const sourceText = metric.sources.length
    ? metric.sources.map((source) => `${source.table}.${source.column}`).join(" + ")
    : "source columns not statically resolved";
  return `
    <button class="metric-lineage-card risk-${safeClassToken(metric.tone)}" type="button" data-registry-id="${escapeHtmlAttribute(metric.id)}">
      <span>${escapeHtml(metric.type)}</span>
      <strong>${escapeHtml(metric.label)}</strong>
      <small>${escapeHtml(metric.businessMeaning)}</small>
      <em>${escapeHtml(sourceText)}</em>
    </button>
  `;
}

function metricsForSelection(analysis, entry) {
  if (!entry) return analysis.profile.metrics;
  const direct = analysis.profile.metrics.filter((metric) => {
    return metric.id === entry.id
      || metric.dependsOnIds.includes(entry.id)
      || entry.predecessors?.includes(metric.id)
      || entry.descendants?.includes(metric.id);
  });
  if (direct.length) return direct;
  if (entry.kind === "projection") return analysis.profile.metrics.filter((metric) => metric.id === entry.id);
  return analysis.profile.metrics;
}

function sourcesForSelection(analysis, entry, metrics = []) {
  const metricSourceIds = new Set(metrics.flatMap((metric) => metric.dependsOnIds));
  const directIds = new Set([entry?.id, ...(entry?.predecessors ?? []), ...(entry?.descendants ?? []), ...metricSourceIds]);
  const direct = analysis.profile.sources.filter((source) => directIds.has(source.id));
  if (direct.length) return direct;
  return analysis.profile.sources;
}

function labelTargets(analysis, targetIds) {
  return targetIds
    .map((id) => analysis.sourceModel.registry.get(id)?.label)
    .filter(Boolean)
    .slice(0, 3);
}

function updateTheaterRail(targetId) {
  const entry = currentAnalysis?.sourceModel.registry.get(targetId);
  elements.theaterNodeLabel.textContent = visibleText(entry?.label || "Result");
  elements.theaterNodeLine.textContent = entry?.lineStart ? `L${entry.lineStart}` : "derived";
  elements.theaterNodeRisk.textContent = entry?.severity || "info";
}

function highlightLensTarget(targetId) {
  if (!currentAnalysis) return;
  const entry = currentAnalysis.sourceModel.registry.get(targetId);
  elements.formatted.querySelectorAll(".lens-line").forEach((node) => {
    node.classList.remove("is-active");
  });
  elements.lensMinimap.querySelectorAll(".lens-mini-line").forEach((node) => {
    node.classList.remove("is-active");
  });

  let first = null;
  if (targetId) {
    elements.formatted.querySelectorAll(`[data-registry-id="${escapeCssString(targetId)}"]`).forEach((node) => {
      node.classList.add("is-active");
      if (!first) first = node;
    });
    elements.lensMinimap.querySelectorAll(`[data-registry-id="${escapeCssString(targetId)}"]`).forEach((node) => {
      node.classList.add("is-active");
    });
  }

  if (!first && entry?.lineStart) {
    const end = entry.lineEnd || entry.lineStart;
    for (let line = entry.lineStart; line <= end; line += 1) {
      const node = elements.formatted.querySelector(`[data-raw-line="${line}"]`);
      if (!node) continue;
      node.classList.add("is-active");
      if (!first) first = node;
    }
  }
  first?.scrollIntoView({ block: "nearest" });
}

function activateLineNumber(lineNumber) {
  if (!Number.isFinite(lineNumber) || !currentAnalysis) return;
  const entry = currentAnalysis.sourceModel.traceLines.find((item) => {
    const start = item.lineStart ?? 0;
    const end = item.lineEnd ?? start;
    return lineNumber >= start && lineNumber <= end;
  });

  if (entry) {
    activateSemanticTarget(entry.id);
    return;
  }

  const rawLine = currentAnalysis.sourceModel.rawLines[lineNumber - 1];
  if (!rawLine) return;
  elements.sql.focus();
  elements.sql.setSelectionRange(rawLine.start, rawLine.end);
  highlightLensTarget("");
  elements.formatted.querySelector(`[data-lens-line="${lineNumber}"]`)?.classList.add("is-active");
  elements.status.textContent = `Raw line ${lineNumber}`;
}

function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function severityRank(severity) {
  return { info: 0, low: 1, medium: 2, high: 3 }[severity] ?? 0;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : "";
}

function findRegistryIdForEvidence(analysis, evidence) {
  const normalized = normalizeEvidence(evidence);
  if (!normalized) return "";
  const match = analysis.sourceModel.traceLines.find((entry) => normalizeEvidence(entry.text) === normalized);
  return match?.id ?? "";
}

function findFindingForEntry(analysis, entry) {
  if (!entry) return null;
  const normalized = normalizeEvidence(entry.text);
  return analysis.diagnosis.findings.find((finding) => normalizeEvidence(finding.evidence) === normalized) || null;
}

function findFlowStepForEntry(analysis, entry) {
  if (!entry) return analysis.flow.steps.at(-1);
  const text = normalizeEvidence(entry.text);
  return analysis.flow.steps.find((step) => normalizeEvidence(step.evidence) === text)
    || analysis.flow.steps.find((step) => step.phase === entry.kind)
    || analysis.flow.steps.at(-1);
}

function pickInitialTarget(analysis) {
  const finding = analysis.diagnosis.findings[0];
  return findRegistryIdForEvidence(analysis, finding?.evidence) || defaultTargetId(analysis);
}

function defaultTargetId(analysis) {
  return analysis?.sourceModel?.resultId || "";
}

function canonicalizeTargetId(analysis, targetId) {
  if (!analysis || !targetId) return "";
  const result = resolveRegistryId(targetId, analysis.sourceModel?.identity);
  return result.status === "resolved" ? result.canonicalId : "";
}

function normalizeEvidence(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function updateInputCounters() {
  const sqlLines = elements.sql.value ? elements.sql.value.split(/\r?\n/).length : 0;
  elements.querySize.textContent = `${sqlLines} line${sqlLines === 1 ? "" : "s"}`;
  elements.schemaSize.textContent = `${currentAnalysis?.schema.tables.size ?? 0} table${currentAnalysis?.schema.tables.size === 1 ? "" : "s"}`;
}

function activateEditorView(name) {
  editorView = ["source", "lens", "schema"].includes(name) ? name : "lens";
  for (const tab of elements.editorTabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.editorView === editorView));
  }
  for (const view of elements.editorViews) {
    const selected = view.id === `editor-${editorView}`;
    view.hidden = !selected;
    view.classList.toggle("active", selected);
  }
}

function bindWorkspaceResizer() {
  if (!elements.workspaceResizer || !elements.workspace) return;
  let dragging = false;

  elements.workspaceResizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 900) return;
    dragging = true;
    elements.workspaceResizer.setPointerCapture(event.pointerId);
    elements.workspaceResizer.classList.add("is-dragging");
  });

  elements.workspaceResizer.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const bounds = elements.workspace.getBoundingClientRect();
    setEditorWidth(event.clientX - bounds.left, bounds.width);
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    elements.workspaceResizer.releasePointerCapture(event.pointerId);
    elements.workspaceResizer.classList.remove("is-dragging");
    window.setTimeout(() => theater?.resize(), 0);
  };

  elements.workspaceResizer.addEventListener("pointerup", stop);
  elements.workspaceResizer.addEventListener("pointercancel", stop);
  elements.workspaceResizer.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || window.innerWidth <= 900) return;
    event.preventDefault();
    const current = document.querySelector(".editor-region")?.getBoundingClientRect().width || 420;
    setEditorWidth(current + (event.key === "ArrowRight" ? 24 : -24), elements.workspace.getBoundingClientRect().width);
    window.setTimeout(() => theater?.resize(), 0);
  });
}

function setEditorWidth(value, workspaceWidth) {
  const min = Math.min(380, workspaceWidth * 0.42);
  const max = Math.max(min, Math.min(760, workspaceWidth - 520));
  const width = Math.round(Math.max(min, Math.min(max, value)));
  elements.workspace.style.setProperty("--editor-width", `${width}px`);
  elements.workspaceResizer.setAttribute("aria-valuenow", String(width));
  writeLocalStorage(LAYOUT_KEY, String(width));
}

function applySavedLayout() {
  try {
    const width = Number(localStorage.getItem(LAYOUT_KEY));
    if (Number.isFinite(width) && width > 0) {
      document.documentElement.style.setProperty("--saved-editor-width", `${width}px`);
    }
  } catch {
    // Local persistence is optional.
  }
}

function activateTab(name) {
  if (name !== "atlas") hideAtlasEvidencePopover();
  for (const tab of elements.tabs) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
  }

  for (const panel of elements.panels) {
    const selected = panel.id === `view-${name}`;
    panel.hidden = !selected;
    panel.classList.toggle("active", selected);
  }

  if (name === "atlas") {
    theater?.resize();
  }
}

function toggleTheaterMode() {
  const expanded = document.body.classList.toggle("theater-maximized");
  elements.theaterToggle.textContent = expanded ? "Dock" : "Expand";
  activateTab("atlas");
  window.setTimeout(() => theater?.resize(), 0);
}

function reportBrowserExportError(error) {
  const primaryError = error?.primaryError ?? error;
  const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const status = error?.dispatchState === BROWSER_DOWNLOAD_STATES.dispatchReturned
    ? `Download started; cleanup failed: ${message}`
    : error?.dispatchState === BROWSER_DOWNLOAD_STATES.dispatchAttempted
      ? `Download may have started; export failed during dispatch: ${message}`
      : error?.dispatchState === BROWSER_DOWNLOAD_STATES.notStarted
        ? `Export failed before download started: ${message}`
        : `Export failed: ${message}`;
  elements.status.textContent = visibleText(status);
  window.__qcErrors.push(status);
}

async function copyRewriteSql() {
  const sql = currentAnalysis?.rewrite.sql ?? "";
  const copied = await copyText(sql);
  elements.status.textContent = copied ? "Parameterized SQL copied" : "Clipboard unavailable";
}

async function copyFormattedSql() {
  const sql = currentAnalysis?.formattedSql ?? "";
  const copied = await copyText(sql);
  elements.status.textContent = copied ? "Formatted SQL copied" : "Clipboard unavailable";
}

async function copyFlightDraft() {
  const sql = currentFlightDraftSql(currentAnalysis);
  const copied = await copyText(sql);
  elements.status.textContent = copied ? "Repair draft copied" : "Clipboard unavailable";
}

function currentFlightDraftSql(analysis) {
  if (!analysis) return "";
  const selectedAction = analysis.flightPlan.actions.find(({ id }) => id === selectedFlightActionId);
  return selectedAction?.previewSql || analysis.flightPlan.draftSql || analysis.ast.sql || "";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function toggleTheme() {
  const next = document.body.classList.contains("theme-light") ? "dark" : "light";
  applyTheme(next);
}

function applyTheme(theme) {
  const light = theme === "light";
  document.body.classList.toggle("theme-light", light);
  elements.theme.textContent = light ? "Use dark theme" : "Use light theme";
  elements.theme.setAttribute("aria-pressed", String(light));
  writeLocalStorage(THEME_KEY, light ? "light" : "dark");
  window.setTimeout(() => theater?.resize(), 0);
}

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || "dark";
  } catch {
    return "dark";
  }
}

function readSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(sql, schema) {
  if (!sql && !schema) {
    removeLocalStorage(STORAGE_KEY);
    return;
  }
  writeLocalStorage(STORAGE_KEY, JSON.stringify({ sql, schema }));
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Local persistence is an optional convenience; analysis must remain live.
    return false;
  }
}

function removeLocalStorage(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
