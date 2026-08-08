import {
  escapeCssString,
  escapeHtml,
  escapeHtmlAttribute,
  replaceTrustedMarkup,
  replaceWithTextState,
  safeClassToken
} from "../security/browserBoundary.js";

export function renderTrace(container, analysis) {
  const traceLines = analysis.sourceModel.traceLines;

  if (traceLines.length === 0) {
    replaceWithTextState(container, "No semantic trace available");
    return;
  }

  replaceTrustedMarkup(container, traceLines.map((entry) => `
    <button
      class="trace-row risk-${safeClassToken(entry.severity)}"
      type="button"
      data-registry-id="${escapeHtmlAttribute(entry.id)}"
      data-line-start="${entry.lineStart ?? ""}"
      data-line-end="${entry.lineEnd ?? ""}">
      <span class="trace-kind">${escapeHtml(entry.kind)}</span>
      <span class="trace-main">
        <strong>${escapeHtml(entry.label)}</strong>
        <code>${escapeHtml(entry.text)}</code>
      </span>
      <span class="trace-line">${entry.lineStart ? `L${entry.lineStart}` : "derived"}</span>
    </button>
  `).join(""));
}

export function activateRegistryTarget(root, targetId, sourceModel) {
  const entry = sourceModel.registry.get(targetId);
  if (!entry) return [];

  const relatedIds = new Set([
    targetId,
    ...entry.predecessors,
    ...entry.descendants
  ]);

  root.querySelectorAll("[data-registry-id]").forEach((node) => {
    const id = node.dataset.registryId;
    node.classList.toggle("is-active", id === targetId);
    node.classList.toggle("is-related", relatedIds.has(id) && id !== targetId);
  });

  root.querySelectorAll("[data-registry-from][data-registry-to]").forEach((node) => {
    const from = node.dataset.registryFrom;
    const to = node.dataset.registryTo;
    node.classList.toggle("is-related", relatedIds.has(from) && relatedIds.has(to));
  });

  return [...relatedIds];
}

export function selectRawSqlLines(textarea, sourceModel, targetId) {
  const entry = sourceModel.registry.get(targetId);
  if (!entry?.lineStart) return;

  const startLine = sourceModel.rawLines[entry.lineStart - 1];
  const endLine = sourceModel.rawLines[(entry.lineEnd || entry.lineStart) - 1] ?? startLine;
  if (!startLine || !endLine) return;

  textarea.focus();
  textarea.setSelectionRange(startLine.start, endLine.end);

  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
  textarea.scrollTop = Math.max(0, (entry.lineStart - 2) * lineHeight);
}

export function pulseSignal(root, targetIds) {
  for (const targetId of targetIds) {
    root.querySelectorAll(`[data-registry-id="${escapeCssString(targetId)}"]`).forEach((node) => {
      node.classList.remove("is-pulsing");
      void node.offsetWidth;
      node.classList.add("is-pulsing");
    });
  }
}
