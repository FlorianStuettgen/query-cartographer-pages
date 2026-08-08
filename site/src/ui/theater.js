import { visibleText } from "../security/browserBoundary.js";

const KIND_LAYER = {
  cte: 0,
  source: 0,
  join: 1,
  where: 2,
  group: 3,
  having: 3,
  order: 4,
  limit: 4,
  projection: 5,
  result: 6
};

const KIND_COLOR = {
  cte: "#6d4fa2",
  source: "#2d5b9a",
  join: "#1f7a5c",
  where: "#a86416",
  group: "#6d4fa2",
  having: "#a86416",
  order: "#2d5b9a",
  limit: "#1f7a5c",
  projection: "#17221d",
  result: "#f4d35e"
};

const RISK_COLOR = {
  high: "#b13f48",
  medium: "#a86416",
  low: "#2d5b9a",
  info: "#1f7a5c"
};

export function createTheater(stage, analysis, onActivate, options = {}) {
  const canvas = stage.querySelector("canvas");
  const context = canvas.getContext("2d");
  const layer = options.layer || "motion";
  const perspective = options.perspective || "debug";
  const filters = options.filters || {};
  const focusIds = new Set(options.focusIds || []);
  const showSelectionLabel = options.showSelectionLabel !== false;
  const requestedSelection = options.selectedId;
  const onSelectionAnchor = typeof options.onSelectionAnchor === "function" ? options.onSelectionAnchor : null;
  const nodes = layoutNodes(analysis.sourceModel.entries);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = buildEdges(nodes, nodeById);
  const flowSteps = analysis.flow.steps;
  const particles = seedParticles(edges);
  let selectedId = requestedSelection && nodeById.has(requestedSelection)
    ? requestedSelection
    : nodes.find((node) => node.kind === "result")?.id || "";
  let frame = 0;
  let animationId = 0;
  let width = 0;
  let height = 0;
  let view = { scale: 1, x: 0, y: 0 };
  let drag = null;
  let suppressClick = false;
  let lastAnchorKey = "";

  const resize = () => {
    const canvasRect = canvas.getBoundingClientRect();
    const rect = canvasRect.width && canvasRect.height ? canvasRect : (canvas.parentElement || stage).getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const compact = rect.width < 620;
    width = Math.max(300, Math.floor(rect.width));
    height = Math.max(compact ? 320 : 240, Math.floor(rect.height));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    positionNodes(focusedNodes(nodes, focusIds), width, height);
    draw();
  };

  const handleClick = (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const point = eventPoint(event, canvas, view);
    const hit = hitTest(focusedNodes(visibleNodes(nodes, filters), focusIds), point.x, point.y);
    if (!hit) return;
    selectedId = hit.id;
    onActivate(hit.id);
    draw();
  };

  const handlePointerDown = (event) => {
    canvas.setPointerCapture(event.pointerId);
    const screen = eventScreenPoint(event, canvas);
    const world = screenToWorld(screen.x, screen.y, view);
    const hit = hitTest(focusedNodes(visibleNodes(nodes, filters), focusIds), world.x, world.y);
    drag = {
      pointerId: event.pointerId,
      mode: hit ? "node" : "pan",
      node: hit,
      startScreen: screen,
      lastScreen: screen,
      moved: false
    };
  };

  const handlePointerMove = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const screen = eventScreenPoint(event, canvas);
    const dx = screen.x - drag.lastScreen.x;
    const dy = screen.y - drag.lastScreen.y;
    if (Math.abs(screen.x - drag.startScreen.x) + Math.abs(screen.y - drag.startScreen.y) > 3) {
      drag.moved = true;
    }

    if (drag.mode === "node" && drag.node) {
      drag.node.x += dx / view.scale;
      drag.node.y += dy / view.scale;
    } else {
      view.x += dx;
      view.y += dy;
    }

    drag.lastScreen = screen;
    draw();
  };

  const handlePointerUp = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    canvas.releasePointerCapture(event.pointerId);
    if (drag.moved) suppressClick = true;
    drag = null;
    draw();
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const screen = eventScreenPoint(event, canvas);
    const before = screenToWorld(screen.x, screen.y, view);
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    view.scale = clamp(view.scale * factor, 0.55, 2.6);
    view.x = screen.x - before.x * view.scale;
    view.y = screen.y - before.y * view.scale;
    draw();
  };

  const tick = () => {
    frame += 1;
    draw();
    animationId = window.requestAnimationFrame(tick);
  };

  const draw = () => {
    drawBackground(context, width, height, frame);
    if (layer === "motion" && width >= 560 && height >= 360) {
      drawFlowBands(context, flowSteps, width, height, frame);
    }
    const selectedNode = nodeById.get(selectedId);
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    drawEdges(context, edges, selectedId, frame, layer, filters, focusIds, perspective);
    if (layer === "motion") drawParticles(context, particles, frame, filters, focusIds);
    drawNodes(context, nodes, selectedId, frame, layer, filters, focusIds, perspective, selectedNode);
    if (showSelectionLabel) drawSelectionLabel(context, selectedNode, width, height);
    context.restore();
    drawLayerReadout(context, layer, analysis, width, view, perspective);
    notifySelectionAnchor();
  };

  const notifySelectionAnchor = () => {
    if (!onSelectionAnchor) return;
    const anchor = projectNode(nodeById.get(selectedId), view);
    const key = anchor ? `${anchor.id}:${anchor.x.toFixed(1)}:${anchor.y.toFixed(1)}:${anchor.radius.toFixed(1)}` : "";
    if (key === lastAnchorKey) return;
    lastAnchorKey = key;
    onSelectionAnchor(anchor);
  };

  canvas.addEventListener("click", handleClick);
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", resize);
  resize();
  tick();

  return {
    select(id) {
      if (nodeById.has(id)) {
        selectedId = id;
        lastAnchorKey = "";
        draw();
      }
    },
    anchor(id = selectedId) {
      return projectNode(nodeById.get(id), view);
    },
    destroy() {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("click", handleClick);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("wheel", handleWheel);
    },
    resize,
    stats() {
      return {
        nodes: nodes.length,
        edges: edges.length,
        focused: focusedNodes(visibleNodes(nodes, filters), focusIds).length,
        visible: visibleNodes(nodes, filters).length
      };
    }
  };
}

function layoutNodes(entries) {
  const nodes = entries.map((entry) => ({
    ...entry,
    layer: KIND_LAYER[entry.kind] ?? 6,
    color: KIND_COLOR[entry.kind] ?? "#1f7a5c",
    baseRadius: entry.kind === "result" ? 22 : entry.severity === "high" ? 20 : 17,
    radius: entry.kind === "result" ? 22 : entry.severity === "high" ? 20 : 17,
    x: 0,
    y: 0
  }));
  return nodes.sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id));
}

function positionNodes(nodes, width, height) {
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.layer)) groups.set(node.layer, []);
    groups.get(node.layer).push(node);
  }

  const layers = [...groups.keys()].sort((a, b) => a - b);
  if (width < 620) {
    positionCompactNodes(groups, layers, width, height);
    return;
  }

  const left = 64;
  const right = width - 244;
  const usableWidth = Math.max(1, right - left);

  layers.forEach((layer, layerIndex) => {
    const group = groups.get(layer);
    const x = left + usableWidth * (layerIndex / Math.max(1, layers.length - 1));
    const usableHeight = Math.max(1, height - 120);
    const dense = group.length > 18;
    const columns = dense ? Math.min(4, Math.ceil(group.length / 24)) : 1;
    const rows = Math.ceil(group.length / columns);
    group.forEach((node, index) => {
      const column = dense ? index % columns : 0;
      const row = dense ? Math.floor(index / columns) : index;
      const spread = dense ? Math.max(12, Math.min(22, usableWidth / Math.max(10, layers.length * 4))) : 0;
      const y = 70 + usableHeight * ((row + 1) / (rows + 1));
      node.radius = dense ? denseRadius(node.baseRadius, group.length) : node.baseRadius;
      node.x = x + (column - (columns - 1) / 2) * spread;
      node.y = y;
      node.dense = dense;
    });
  });
}

function positionCompactNodes(groups, layers, width, height) {
  const top = 58;
  const bottom = height - 92;
  const usableHeight = Math.max(1, bottom - top);
  const left = 40;
  const usableWidth = Math.max(1, width - left * 2);

  layers.forEach((layer, layerIndex) => {
    const group = groups.get(layer);
    const y = top + usableHeight * (layerIndex / Math.max(1, layers.length - 1));
    const dense = group.length > 18;
    const rows = dense ? Math.min(5, Math.ceil(group.length / 24)) : 1;
    const columns = Math.ceil(group.length / rows);
    group.forEach((node, index) => {
      const row = dense ? index % rows : 0;
      const column = dense ? Math.floor(index / rows) : index;
      node.radius = dense ? denseRadius(node.baseRadius, group.length) : node.baseRadius;
      node.x = left + usableWidth * ((column + 1) / (columns + 1));
      node.y = y + (row - (rows - 1) / 2) * Math.max(11, node.radius * 2.8);
      node.dense = dense;
    });
  });
}

function denseRadius(baseRadius, groupSize) {
  if (groupSize > 72) return Math.min(baseRadius, 3.8);
  if (groupSize > 42) return Math.min(baseRadius, 5);
  return Math.min(baseRadius, 7);
}

function buildEdges(nodes, nodeById) {
  const edges = [];
  for (const node of nodes) {
    for (const predecessorId of node.predecessors) {
      const from = nodeById.get(predecessorId);
      if (from) edges.push({ from, to: node, risk: maxRisk(from.severity, node.severity) });
    }
  }
  return edges;
}

function seedParticles(edges) {
  return edges.map((edge, index) => ({
    edge,
    offset: (index * 0.137) % 1,
    speed: 0.0028 + (index % 5) * 0.00042
  }));
}

function drawBackground(ctx, width, height, frame) {
  const drift = (frame * 0.22) % 36;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#050909");
  gradient.addColorStop(0.48, "#0b151b");
  gradient.addColorStop(1, "#111527");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(47, 208, 161, 0.08)";
  ctx.lineWidth = 1;
  for (let x = -36 + drift; x < width; x += 36) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 90, height);
    ctx.stroke();
  }
  for (let y = -36 + drift; y < height; y += 36) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y + 30);
    ctx.stroke();
  }
  ctx.restore();

  const lanes = ["sources", "joins", "filters", "grain", "result"];
  const laneTop = 42;
  const laneHeight = Math.max(58, (height - 180) / lanes.length);
  ctx.save();
  ctx.font = "700 10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lanes.forEach((lane, index) => {
    const y = laneTop + laneHeight * index;
    ctx.strokeStyle = "rgba(238, 246, 243, 0.055)";
    ctx.beginPath();
    ctx.moveTo(24, y);
    ctx.lineTo(width - 24, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(238, 246, 243, 0.28)";
    ctx.fillText(lane.toUpperCase(), 30, y + 16);
  });
  ctx.restore();
}

function drawFlowBands(ctx, steps, width, height, frame) {
  if (!steps.length) return;
  const maxVisible = Math.min(steps.length, width < 720 ? 5 : 8);
  const visible = steps.slice(0, maxVisible);
  const overflow = steps.length - visible.length;
  const left = 32;
  const right = width - 32;
  const y = height - 98;
  const bandHeight = 58;
  const gap = 7;
  const bandWidth = Math.max(92, (right - left - gap * (visible.length - 1)) / visible.length);

  ctx.save();
  ctx.font = "700 10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  visible.forEach((step, index) => {
    const x = left + index * (bandWidth + gap);
    const color = RISK_COLOR[step.risk] ?? "#2fd0a1";
    const pulse = 0.12 + Math.sin(frame / 20 + index) * 0.04;
    ctx.fillStyle = hexToRgba(color, 0.13 + pulse);
    ctx.strokeStyle = hexToRgba(color, 0.72);
    ctx.lineWidth = 1.2;
    roundRect(ctx, x, y, bandWidth, bandHeight, 8);
    ctx.fill();
    ctx.stroke();

    const change = step.change > 1.2 ? `x${step.change.toFixed(1)}` : step.change < 0.82 ? `${Math.round(step.change * 100)}%` : "steady";
    ctx.fillStyle = "rgba(238, 246, 243, 0.62)";
    ctx.fillText(`${String(index + 1).padStart(2, "0")} ${step.phase.toUpperCase()}`, x + 10, y + 15);
    ctx.fillStyle = "#eef6f3";
    ctx.fillText(truncate(step.label, Math.floor(bandWidth / 8)), x + 10, y + 32);
    ctx.fillStyle = color;
    ctx.fillText(`${compactRows(step.afterRows)} / ${change}`, x + 10, y + 48);

    if (index < visible.length - 1) {
      ctx.strokeStyle = "rgba(238, 246, 243, 0.34)";
      ctx.beginPath();
      ctx.moveTo(x + bandWidth + 2, y + bandHeight / 2);
      ctx.lineTo(x + bandWidth + gap - 2, y + bandHeight / 2);
      ctx.stroke();
    }
  });

  if (overflow > 0) {
    ctx.fillStyle = "rgba(238, 246, 243, 0.55)";
    ctx.fillText(`+${overflow} more`, right - 62, y - 12);
  }
  ctx.restore();
}

function drawEdges(ctx, edges, selectedId, frame, layer, filters, focusIds, perspective) {
  for (const edge of edges) {
    if (!nodeVisible(edge.from, filters) || !nodeVisible(edge.to, filters)) continue;
    if (focusIds.size > 0 && (!focusIds.has(edge.from.id) || !focusIds.has(edge.to.id))) continue;
    const active = edge.from.id === selectedId || edge.to.id === selectedId;
    const inLayer = edgeInLayer(edge, layer);
    const focused = focusIds.size === 0 || focusIds.has(edge.from.id) || focusIds.has(edge.to.id);
    const perspectiveWeight = edgePerspectiveWeight(edge, perspective);
    const pulse = active ? 0.52 + Math.sin(frame / 16) * 0.22 : 0;
    const color = RISK_COLOR[edge.risk] ?? "#7fa696";

    ctx.save();
    ctx.globalAlpha = active ? 1 : (focused && inLayer ? 0.78 : focused ? 0.34 : 0.07) * perspectiveWeight;
    ctx.strokeStyle = active || layer === "risk" ? color : "rgba(207, 216, 210, 0.24)";
    ctx.lineWidth = active ? 2.8 + pulse : inLayer ? 1.6 : 0.9;
    ctx.shadowColor = active ? color : "transparent";
    ctx.shadowBlur = active ? 14 : 0;
    drawCurve(ctx, edge.from, edge.to);
    ctx.stroke();
    ctx.restore();
  }
}

function drawParticles(ctx, particles, frame, filters, focusIds) {
  for (const particle of particles) {
    if (!nodeVisible(particle.edge.from, filters) || !nodeVisible(particle.edge.to, filters)) continue;
    if (focusIds.size > 0 && (!focusIds.has(particle.edge.from.id) || !focusIds.has(particle.edge.to.id))) continue;
    const progress = (particle.offset + frame * particle.speed) % 1;
    const point = curvePoint(particle.edge.from, particle.edge.to, progress);
    const color = RISK_COLOR[particle.edge.risk] ?? "#1f7a5c";
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawNodes(ctx, nodes, selectedId, frame, layer, filters, focusIds, perspective, selectedNode = null) {
  for (const node of nodes) {
    if (!nodeVisible(node, filters)) continue;
    if (focusIds.size > 0 && !focusIds.has(node.id)) continue;
    const active = node.id === selectedId;
    const selectedIsResult = selectedNode?.kind === "result";
    const related = !selectedIsResult && (node.predecessors.includes(selectedId) || node.descendants.includes(selectedId));
    const inLayer = nodeInLayer(node, layer);
    const focused = focusIds.size === 0 || focusIds.has(node.id);
    const explicitlyFocused = focusIds.has(node.id);
    const perspectiveWeight = nodePerspectiveWeight(node, perspective);
    const showLabel = active
      || related
      || explicitlyFocused
      || node.kind === "result"
      || (layer === "risk" && focused && node.severity === "high")
      || perspectiveLabelVisible(node, perspective, focused);
    const riskColor = RISK_COLOR[node.severity] ?? "#1f7a5c";
    const visualRadius = active ? Math.max(node.radius, 18) : node.radius;
    const glow = active ? 24 : related ? 12 : node.severity === "high" && !node.dense ? 10 : 0;

    ctx.save();
    ctx.globalAlpha = active ? 1 : (node.dense ? 0.46 : focused && inLayer ? 0.92 : focused ? 0.44 : 0.1) * perspectiveWeight;
    ctx.shadowColor = active ? node.color : riskColor;
    ctx.shadowBlur = glow;
    ctx.fillStyle = active
      ? "#fffdf2"
      : node.dense
        ? hexToRgba(node.color, 0.8)
        : node.kind === "result"
          ? "#f4d35e"
          : "#f8fbf8";
    ctx.strokeStyle = active
      ? node.color
      : node.dense
        ? hexToRgba(node.color, 0.92)
        : node.severity === "high"
          ? riskColor
          : "rgba(255,255,255,0.58)";
    ctx.lineWidth = active ? 3 : node.dense ? 0.8 : node.severity === "high" ? 2.3 : 1.4;
    ctx.beginPath();
    ctx.arc(node.x, node.y, visualRadius + (active ? Math.sin(frame / 12) * 1.5 : 0), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (!node.dense || active || related || explicitlyFocused || node.kind === "result") {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#17221d";
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(shortCode(node), node.x, node.y);
    }

    if (showLabel) {
      ctx.fillStyle = active ? "#f4d35e" : "rgba(243, 247, 244, 0.78)";
      ctx.font = active ? "700 12px Inter, system-ui, sans-serif" : "600 11px Inter, system-ui, sans-serif";
      ctx.fillText(truncate(node.label, active ? 26 : 16), node.x, node.y + visualRadius + 17);
    }
    ctx.restore();
  }
}

function drawLayerReadout(ctx, layer, analysis, width, view, perspective) {
  const readout = layerReadout(layer, analysis, perspective);
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(238, 246, 243, 0.62)";
  ctx.fillText(visibleText(`${readout} / ${Math.round(view.scale * 100)}%`), width / 2, 24);
  ctx.restore();
}

function layerReadout(layer, analysis, perspective = "debug") {
  if (perspective === "decision") {
    const high = analysis.diagnosis.severityCounts.high ?? 0;
    return `DECISION / ${layer.toUpperCase()} / ${high} blocker${high === 1 ? "" : "s"} / ${compactRows(analysis.flow.maxRows)} peak`;
  }
  if (perspective === "metrics") {
    return `METRICS / ${layer.toUpperCase()} / ${(analysis.profile?.metrics || []).length} signals / ${analysis.profile?.grain?.value || "unknown grain"}`;
  }
  if (perspective === "debug") {
    return `DEBUG / ${layer.toUpperCase()} / ${analysis.dialect?.label || "ANSI-ish"} / ${analysis.sourceModel.entries.length} nodes`;
  }
  if (layer === "risk") {
    const high = analysis.diagnosis.severityCounts.high ?? 0;
    const medium = analysis.diagnosis.severityCounts.medium ?? 0;
    return `RISK LAYER / ${high} high / ${medium} medium`;
  }
  if (layer === "grain") {
    return `GRAIN LAYER / ${analysis.profile?.grain?.label || "projection-driven"}`;
  }
  if (layer === "metrics") {
    return `METRICS LAYER / ${(analysis.profile?.metrics || []).length} output signals`;
  }
  if (layer === "lineage") {
    return `LINEAGE LAYER / ${analysis.sourceModel.entries.length} semantic nodes`;
  }
  return `MOTION LAYER / ${compactRows(analysis.flow.maxRows)} peak / ${analysis.flow.blastRadius.toFixed(1)}x blast`;
}

function nodePerspectiveWeight(node, perspective) {
  if (perspective === "decision") {
    if (node.kind === "result" || node.severity === "high") return 1;
    if (node.severity === "medium" || ["join", "group", "having"].includes(node.kind)) return 0.7;
    return 0.28;
  }
  if (perspective === "metrics") {
    if (["source", "cte", "group", "having", "projection", "result"].includes(node.kind)) return 1;
    if (["join", "where"].includes(node.kind)) return 0.68;
    return 0.4;
  }
  return 1;
}

function edgePerspectiveWeight(edge, perspective) {
  if (perspective === "decision") {
    if (edge.risk === "high" || edge.from.kind === "result" || edge.to.kind === "result") return 1;
    if (edge.risk === "medium") return 0.68;
    return 0.3;
  }
  if (perspective === "metrics") {
    const importantKinds = ["source", "cte", "group", "having", "projection", "result"];
    return importantKinds.includes(edge.from.kind) || importantKinds.includes(edge.to.kind) ? 1 : 0.55;
  }
  return 1;
}

function perspectiveLabelVisible(node, perspective, focused) {
  if (!focused || node.dense) return false;
  if (perspective === "decision") return node.severity === "high";
  if (perspective === "metrics") return ["group", "having", "projection"].includes(node.kind);
  return node.severity === "high";
}

function nodeInLayer(node, layer) {
  if (layer === "risk") return ["high", "medium"].includes(node.severity) || node.kind === "result";
  if (layer === "grain") return ["group", "having", "projection", "result"].includes(node.kind);
  if (layer === "metrics") return ["source", "join", "projection", "result"].includes(node.kind);
  if (layer === "lineage") return true;
  return true;
}

function edgeInLayer(edge, layer) {
  if (layer === "risk") return ["high", "medium"].includes(edge.risk);
  if (layer === "grain") return nodeInLayer(edge.from, "grain") || nodeInLayer(edge.to, "grain");
  if (layer === "metrics") return nodeInLayer(edge.from, "metrics") || nodeInLayer(edge.to, "metrics");
  return true;
}

function visibleNodes(nodes, filters) {
  return nodes.filter((node) => nodeVisible(node, filters));
}

function focusedNodes(nodes, focusIds) {
  return focusIds.size ? nodes.filter((node) => focusIds.has(node.id)) : nodes;
}

function nodeVisible(node, filters) {
  if (node.kind === "result") return true;
  if (["source", "cte"].includes(node.kind)) return filters.sources !== false;
  if (node.kind === "join") return filters.joins !== false;
  if (["where", "having"].includes(node.kind)) return filters.filters !== false;
  if (["group", "order", "limit"].includes(node.kind)) return filters.grain !== false;
  if (node.kind === "projection") return filters.select !== false;
  return true;
}

function drawSelectionLabel(ctx, node, width, height) {
  if (!node) return;
  const label = visibleText(`${node.kind.toUpperCase()} / ${node.label}`);
  const detail = node.lineStart ? `raw line ${node.lineStart}` : "derived node";
  ctx.save();
  ctx.font = "700 12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const boxWidth = Math.min(360, Math.max(220, label.length * 7.2));
  const x = Math.max(28, Math.min(width - boxWidth - 28, node.x + 28));
  const y = Math.max(24, Math.min(height - 176, node.y - 34));
  ctx.fillStyle = "rgba(5, 9, 9, 0.76)";
  ctx.strokeStyle = "rgba(238, 246, 243, 0.18)";
  roundRect(ctx, x, y, boxWidth, 50, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#eef6f3";
  ctx.fillText(truncate(label, 42), x + 12, y + 18);
  ctx.fillStyle = "rgba(238, 246, 243, 0.58)";
  ctx.fillText(detail, x + 12, y + 34);
  ctx.restore();
}

function projectNode(node, view) {
  if (!node) return null;
  return {
    id: node.id,
    x: node.x * view.scale + view.x,
    y: node.y * view.scale + view.y,
    radius: node.radius * view.scale
  };
}

function drawCurve(ctx, from, to) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  if (Math.abs(to.y - from.y) > Math.abs(to.x - from.x)) {
    const control = Math.max(46, Math.abs(to.y - from.y) * 0.44);
    ctx.bezierCurveTo(from.x, from.y + control, to.x, to.y - control, to.x, to.y);
    return;
  }

  const control = Math.max(60, Math.abs(to.x - from.x) * 0.48);
  ctx.bezierCurveTo(from.x + control, from.y, to.x - control, to.y, to.x, to.y);
}

function curvePoint(from, to, t) {
  const p0 = { x: from.x, y: from.y };
  const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
  const control = vertical
    ? Math.max(46, Math.abs(to.y - from.y) * 0.44)
    : Math.max(60, Math.abs(to.x - from.x) * 0.48);
  const p1 = vertical ? { x: from.x, y: from.y + control } : { x: from.x + control, y: from.y };
  const p2 = vertical ? { x: to.x, y: to.y - control } : { x: to.x - control, y: to.y };
  const p3 = { x: to.x, y: to.y };
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y
  };
}

function shortCode(node) {
  if (node.kind === "result") return "R";
  if (node.kind === "projection") return "S";
  if (node.kind === "source") return "T";
  return node.kind.slice(0, 1).toUpperCase();
}

function maxRisk(a, b) {
  const rank = { info: 0, low: 1, medium: 2, high: 3 };
  return (rank[a] ?? 0) > (rank[b] ?? 0) ? a : b;
}

function truncate(text, max) {
  const value = visibleText(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function hitTest(nodes, x, y) {
  return [...nodes].reverse().find((node) => distance(x, y, node.x, node.y) <= Math.max(node.radius + 9, node.dense ? 11 : 0));
}

function eventPoint(event, canvas, view) {
  const screen = eventScreenPoint(event, canvas);
  return screenToWorld(screen.x, screen.y, view);
}

function eventScreenPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function screenToWorld(x, y, view) {
  return {
    x: (x - view.x) / view.scale,
    y: (y - view.y) / view.scale
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function compactRows(value) {
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 1_000_000_000) return `${(rounded / 1_000_000_000).toFixed(1)}B`;
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}K`;
  return String(rounded);
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}
