const ENTRY_ORDER = ["cte", "source", "source-asset", "join", "where", "group", "having", "order", "limit", "projection", "result"];

const X_BY_KIND = {
  cte: 36,
  source: 36,
  "source-asset": 36,
  join: 294,
  where: 552,
  group: 552,
  having: 552,
  order: 552,
  limit: 552,
  projection: 552,
  result: 800
};

export function renderLineageMap(container, analysis) {
  const { ast, sourceModel } = analysis;

  if (!ast.sql?.trim()) {
    container.innerHTML = `<div class="empty-state">No query analyzed</div>`;
    return;
  }

  if (ast.unsupported) {
    container.innerHTML = `<div class="empty-state">Read-only map unavailable for ${escapeHtml(ast.statementType.toUpperCase())}</div>`;
    return;
  }

  container.innerHTML = buildMap(sourceModel);
}

function buildMap(sourceModel) {
  const nodes = [];
  const edges = [];
  const edgeSet = new Set();
  const entries = [...(sourceModel?.entries ?? [])];
  const buckets = bucketEntries(entries);

  if (!entries.length) {
    return `<div class="empty-state">No analyzed semantic model</div>`;
  }

  const rowGap = 92;
  const startY = 76;
  const nodeWidth = 174;
  const nodeHeight = 58;
  const yByKind = new Map();

  for (const kind of ENTRY_ORDER) yByKind.set(kind, startY);

  const stagedEntries = [];
  for (const kind of ENTRY_ORDER) stagedEntries.push(...(buckets[kind] ?? []));

  for (const entry of stagedEntries) {
    const kind = sanitizeKind(entry.kind);
    const x = X_BY_KIND[kind] ?? 36;
    const y = nextY(kind);

    nodes.push(node({
      id: entry.id,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      label: entry.label || kind.toUpperCase(),
      detail: summarize(String(entry.text || "")) || summarize(String(entry.detail || "")),
      type: kind,
      risk: entry.severity === "high"
    }));

    for (const predecessor of uniquePredecessors(entry.predecessors)) {
      if (predecessor === entry.id) continue;
      addEdge(predecessor, entry.id, "", entry.severity === "high");
    }
  }

  const width = 1010;
  const height = Math.max(560, Math.max(...nodes.map((entry) => entry.y + entry.height + 36), 560));
  const nodeById = new Map(nodes.map((entry) => [entry.id, entry]));

  return `
    <svg class="query-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="SQL lineage map">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#51645b"></path>
        </marker>
        <marker id="arrow-risk" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b13f48"></path>
        </marker>
      </defs>
      ${edges.map((entry) => renderEdge(entry, nodeById)).join("")}
      ${nodes.map(renderNode).join("")}
    </svg>
  `;

  function nextY(kind) {
    const key = kind || "source";
    const current = yByKind.get(key) ?? startY;
    yByKind.set(key, current + rowGap);
    return current;
  }

  function addEdge(from, to, label, risk) {
    if (!from || !to || from === to) return;
    if (edgeSet.has(`${from}\u2192${to}`)) return;
    edgeSet.add(`${from}\u2192${to}`);
    edges.push(edge(from, to, label, risk));
  }
}

function bucketEntries(entries) {
  const buckets = Object.fromEntries(ENTRY_ORDER.map((kind) => [kind, []]));

  for (const entry of entries) {
    if (!entry?.id) continue;
    const kind = sanitizeKind(entry.kind);
    const bucket = buckets[kind];
    if (bucket) {
      bucket.push(entry);
    }
  }

  for (const kind of Object.keys(buckets)) {
    buckets[kind].sort((a, b) => (a.lineStart ?? 9999) - (b.lineStart ?? 9999));
  }

  return buckets;
}

function uniquePredecessors(predecessors = []) {
  return [...new Set(predecessors.filter(Boolean))];
}

function sanitizeKind(kind) {
  if (kind === "source" || kind === "cte" || kind === "join" || kind === "where" || kind === "group" || kind === "having" || kind === "order" || kind === "limit" || kind === "projection" || kind === "result") {
    return kind;
  }
  if (kind === "source-asset") return "source-asset";
  return "source";
}

function node({ id, x, y, width, height, label, detail, type, risk }) {
  return { id, x, y, width, height, label, detail, type, risk };
}

function edge(from, to, label, risk) {
  return { from, to, label, risk };
}

function renderNode(entry) {
  return `
    <g class="node node-${escapeAttr(entry.type)} ${entry.risk ? "node-risk" : ""}" data-registry-id="${escapeAttr(entry.id)}" transform="translate(${entry.x} ${entry.y})">
      <rect class="node-rect" width="${entry.width}" height="${entry.height}" rx="8"></rect>
      <text class="node-label" x="14" y="24">${escapeHtml(summarize(entry.label, 22))}</text>
      <text class="node-detail" x="14" y="43">${escapeHtml(summarize(entry.detail, 28))}</text>
      <title>${escapeHtml(`${entry.label} ${entry.detail}`)}</title>
    </g>
  `;
}

function renderEdge(entry, nodeById) {
  const from = nodeById.get(entry.from);
  const to = nodeById.get(entry.to);
  if (!from || !to) return "";

  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const mid = Math.max(x1 + 44, (x1 + x2) / 2);
  const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  const labelX = (x1 + x2) / 2;
  const labelY = (y1 + y2) / 2 - 8;

  return `
    <path class="edge ${entry.risk ? "edge-risk" : ""}" data-registry-from="${escapeAttr(entry.from)}" data-registry-to="${escapeAttr(entry.to)}" d="${path}" marker-end="url(#${entry.risk ? "arrow-risk" : "arrow"})"></path>
    ${entry.label ? `<text class="edge-label" x="${labelX}" y="${labelY}">${escapeHtml(summarize(entry.label, 30))}</text>` : ""}
  `;
}

function summarize(value, max = 42) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "");
}
