import {
  CANONICAL_JSON_CONTRACT_VERSION,
  CANONICAL_JSON_SCHEMA_ID,
  CANONICAL_JSON_SCHEMA_VERSION,
  buildCanonicalJsonExport,
  canonicalizeCanonicalJsonExport
} from "./exportContract.js";

export const DETERMINISTIC_MARKDOWN_SCHEMA_ID = "query-cartographer.deterministic-markdown-export";
export const DETERMINISTIC_MARKDOWN_SCHEMA_VERSION = "1";
export const DETERMINISTIC_MARKDOWN_CONTRACT_VERSION = "1.0.1";
export const DETERMINISTIC_MARKDOWN_SECTION_ORDER = Object.freeze([
  "Contract and Identity",
  "Assessment State",
  "Input Fingerprints",
  "Inventory Counts",
  "Findings",
  "Metrics",
  "Flow Stages",
  "Ranked Repair Actions",
  "Semantic Entities",
  "Lineage Routes",
  "Explicit Limitations"
]);

const COMMONMARK_ASCII_PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
const GFM_AUTOLINK_CANDIDATE = /https?:\/\/|www\.|@/iu;
const UNSAFE_MARKDOWN_CHARACTER = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;

export function buildDeterministicMarkdownExport(analysis, options = {}) {
  const canonical = buildCanonicalJsonExport(analysis);
  return serializeDeterministicMarkdownExport(canonical, options);
}

export function serializeDeterministicMarkdownExport(document, {
  contractVersion = DETERMINISTIC_MARKDOWN_CONTRACT_VERSION
} = {}) {
  if (contractVersion !== DETERMINISTIC_MARKDOWN_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported deterministic Markdown contract version: ${String(contractVersion)}`);
  }

  const canonical = canonicalizeCanonicalJsonExport(document);
  const lines = [
    "# Query Cartographer Deterministic Report",
    "",
    "This report is a deterministic human-readable projection of the validated canonical JSON export.",
    ""
  ];

  pushSection(lines, "Contract and Identity");
  pushMetadata(lines, "Markdown schema ID", DETERMINISTIC_MARKDOWN_SCHEMA_ID);
  pushMetadata(lines, "Markdown schema version", DETERMINISTIC_MARKDOWN_SCHEMA_VERSION);
  pushMetadata(lines, "Markdown contract version", contractVersion);
  pushMetadata(lines, "Canonical JSON schema ID", CANONICAL_JSON_SCHEMA_ID);
  pushMetadata(lines, "Canonical JSON schema version", CANONICAL_JSON_SCHEMA_VERSION);
  pushMetadata(lines, "Canonical JSON contract version", CANONICAL_JSON_CONTRACT_VERSION);
  pushMetadata(lines, "Canonical analysis ID", canonical.analysis.id);
  pushMetadata(lines, "Canonical input ID", canonical.input.id);
  lines.push("");

  pushSection(lines, "Assessment State");
  pushMetadata(lines, "Status", canonical.state.status);
  pushMetadata(lines, "Risk level", canonical.state.riskLevel);
  pushMetadata(lines, "Risk score", canonical.state.score);
  pushMetadata(lines, "Complexity", canonical.flow.summary.complexity);
  pushMetadata(lines, "Blast radius", canonical.flow.summary.blastRadius);
  pushMetadata(lines, "Maximum rows", canonical.flow.summary.maxRows);
  pushMetadata(lines, "Final rows", canonical.flow.summary.finalRows);
  lines.push("");

  pushSection(lines, "Input Fingerprints");
  pushMetadata(lines, "Digest algorithm", canonical.input.digestAlgorithm);
  pushMetadata(lines, "SQL digest", canonical.input.sqlDigest);
  pushMetadata(lines, "Schema digest", canonical.input.schemaDigest);
  lines.push("");

  pushSection(lines, "Inventory Counts");
  pushMetadata(lines, "Entities", canonical.entities.length);
  pushMetadata(lines, "Routes", canonical.routes.length);
  pushMetadata(lines, "Findings", canonical.findings.length);
  pushMetadata(lines, "Metrics", canonical.metrics.length);
  pushMetadata(lines, "Repair actions", canonical.actions.length);
  pushMetadata(lines, "Flow stages", canonical.flow.stages.length);
  lines.push("");

  pushSection(lines, "Findings");
  if (canonical.findings.length === 0) {
    lines.push("No findings were emitted.", "");
  } else {
    canonical.findings.forEach((finding, index) => {
      lines.push(`### Finding ${index + 1}: \[${escapeMarkdownInline(finding.severity.toUpperCase())}\] ${escapeMarkdownInline(finding.title)}`, "");
      pushMetadata(lines, "Stable ID", finding.id);
      pushMetadata(lines, "Category", finding.category);
      pushMetadata(lines, "Target stable IDs", formatIdList(finding.targetIds));
      pushLabeledText(lines, "Detail", finding.detail);
      pushLabeledCode(lines, "Evidence", finding.evidence, "sql");
      pushLabeledText(lines, "Suggestion", finding.suggestion);
    });
  }

  pushSection(lines, "Metrics");
  if (canonical.metrics.length === 0) {
    lines.push("No metrics were emitted.", "");
  } else {
    canonical.metrics.forEach((metric, index) => {
      lines.push(`### Metric ${index + 1}: ${escapeMarkdownInline(metric.label)}`, "");
      pushMetadata(lines, "Stable ID", metric.id);
      pushMetadata(lines, "Type", metric.type);
      pushMetadata(lines, "Tone", metric.tone);
      pushMetadata(lines, "Grain", metric.grain);
      pushMetadata(lines, "Target stable IDs", formatIdList(metric.targetIds));
      pushLabeledCode(lines, "Expression", metric.expression, "sql");
      pushLabeledText(lines, "Business meaning", metric.businessMeaning);
      pushLabeledText(lines, "Risk", metric.risk);
    });
  }

  pushSection(lines, "Flow Stages");
  if (canonical.flow.stages.length === 0) {
    lines.push("No flow stages were emitted.", "");
  } else {
    canonical.flow.stages.forEach((stage) => {
      lines.push(`### Stage ${stage.ordinal}`, "");
      pushMetadata(lines, "Ordinal", stage.ordinal);
      pushMetadata(lines, "Label", stage.label);
      pushMetadata(lines, "Phase", stage.phase);
      pushMetadata(lines, "Risk", stage.risk);
      pushMetadata(lines, "Rows before", stage.beforeRows);
      pushMetadata(lines, "Rows after", stage.afterRows);
      pushMetadata(lines, "Change", stage.change);
      pushLabeledText(lines, "Detail", stage.detail);
      pushLabeledCode(lines, "Evidence", stage.evidence, "sql");
    });
  }

  pushSection(lines, "Ranked Repair Actions");
  if (canonical.actions.length === 0) {
    lines.push("No repair actions were emitted.", "");
  } else {
    canonical.actions.forEach((action) => {
      lines.push(`### Action ${action.rank}: \[${escapeMarkdownInline(action.severity.toUpperCase())}\] ${escapeMarkdownInline(action.title)}`, "");
      pushMetadata(lines, "Stable ID", action.id);
      pushMetadata(lines, "Rank", action.rank);
      pushMetadata(lines, "Category", action.category);
      pushMetadata(lines, "Confidence", action.confidence);
      pushMetadata(lines, "Applied", action.applied);
      pushMetadata(lines, "Row factor", action.rowFactor);
      pushMetadata(lines, "Risk delta", action.riskDelta);
      pushMetadata(lines, "Complexity delta", action.complexityDelta);
      pushMetadata(lines, "Target stable IDs", formatIdList(action.targetIds));
      pushLabeledText(lines, "Maneuver", action.maneuver);
      pushLabeledText(lines, "Why", action.why);
      pushLabeledCode(lines, "Preview SQL", action.previewSql, "sql");
    });
  }

  pushSection(lines, "Semantic Entities");
  if (canonical.entities.length === 0) {
    lines.push("No semantic entities were emitted.", "");
  } else {
    canonical.entities.forEach((entity, index) => {
      lines.push(`### Entity ${index + 1}`, "");
      pushMetadata(lines, "Stable ID", entity.id);
      pushMetadata(lines, "Label", entity.label);
      pushMetadata(lines, "Kind", entity.kind);
      pushLabeledCode(lines, "Source text", entity.text, "sql");
    });
  }

  pushSection(lines, "Lineage Routes");
  if (canonical.routes.length === 0) {
    lines.push("No lineage routes were emitted.", "");
  } else {
    canonical.routes.forEach((route, index) => {
      lines.push(`### Route ${index + 1}`, "");
      pushMetadata(lines, "From stable ID", route.fromId);
      pushMetadata(lines, "To stable ID", route.toId);
      pushMetadata(lines, "Type", route.type);
      lines.push("");
    });
  }

  pushSection(lines, "Explicit Limitations");
  canonical.limitations.forEach((limitation, index) => {
    lines.push(`### Limitation ${index + 1}`, "");
    pushMetadata(lines, "Code", limitation.code);
    pushLabeledText(lines, "Detail", limitation.detail);
  });

  return finalizeMarkdown(lines);
}

export function escapeMarkdownInline(value) {
  const text = normalizeText(value).replace(/\n+/g, " ");
  if (GFM_AUTOLINK_CANDIDATE.test(text)) return inlineCode(text);

  const escaped = [...text]
    .map(escapeMarkdownCharacter)
    .join("");
  return protectBoundaryWhitespace(escaped);
}

export function renderMarkdownCodeBlock(value, language = "text") {
  const text = normalizeText(value);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  const safeLanguage = /^[a-z0-9_-]+$/i.test(language) ? language : "text";
  const trailingLfCount = countTrailingLf(text);
  const closingSeparator = text && !text.endsWith("\n") ? "\n" : "";
  return `${fence}${safeLanguage} qc-trailing-lf=${trailingLfCount}\n${text}${closingSeparator}${fence}`;
}

function pushSection(lines, name) {
  lines.push(`## ${name}`, "");
}

function pushMetadata(lines, label, value) {
  lines.push(`- **${escapeMarkdownInline(label)}:** ${inlineCode(formatScalar(value))}`);
}

function pushLabeledText(lines, label, value) {
  ensureBlankLine(lines);
  lines.push(`**${escapeMarkdownInline(label)}**`, "", escapeMarkdownParagraph(value), "");
}

function pushLabeledCode(lines, label, value, language) {
  ensureBlankLine(lines);
  lines.push(`**${escapeMarkdownInline(label)}**`, "", renderMarkdownCodeBlock(value, language), "");
}

function ensureBlankLine(lines) {
  if (lines.at(-1) !== "") lines.push("");
}

function formatIdList(ids) {
  return ids.length ? ids.join(", ") : "none";
}

function formatScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  return String(value);
}

function inlineCode(value) {
  const text = normalizeText(value).replace(/\n+/g, " ");
  if (text === "") return "<code></code>";
  const delimiter = "`".repeat(Math.max(1, longestBacktickRun(text) + 1));
  if (/^ +$/.test(text)) return `${delimiter}${text}${delimiter}`;
  const padded = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") || text.endsWith(" ");
  return `${delimiter}${padded ? " " : ""}${text}${padded ? " " : ""}${delimiter}`;
}

function escapeMarkdownParagraph(value) {
  return normalizeText(value)
    .split("\n")
    .map((line) => escapeMarkdownInline(line))
    .join("  \n");
}

function protectBoundaryWhitespace(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, (whitespace) => (
    [...whitespace].map((character) => character === "\t" ? "&#9;" : "&#32;").join("")
  ));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_MARKDOWN_CHARACTER, visibleUnicodeEscape);
}

function visibleUnicodeEscape(character) {
  return `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}}`;
}

function escapeMarkdownCharacter(character) {
  if (character === "&") return "&amp;";
  if (character === "<") return "&lt;";
  if (character === ">") return "&gt;";
  return COMMONMARK_ASCII_PUNCTUATION.has(character) ? `\\${character}` : character;
}

function longestBacktickRun(value) {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function countTrailingLf(value) {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\n"; index -= 1) count += 1;
  return count;
}

function finalizeMarkdown(lines) {
  const output = lines.join("\n").replace(/\n+$/g, "");
  if (output.includes("\r")) throw new TypeError("Deterministic Markdown output must use LF line endings");
  return `${output}\n`;
}
