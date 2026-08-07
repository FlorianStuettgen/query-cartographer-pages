import { compactIdentifier, normalizeIdentifier, splitTopLevel, tokenize, tokensToText } from "./tokenizer.js";

const CONSTRAINT_WORDS = new Set([
  "primary",
  "references",
  "not",
  "null",
  "unique",
  "constraint",
  "default",
  "check",
  "collate",
  "generated",
  "identity"
]);

const SENSITIVE_PATTERNS = [
  /email/i,
  /e-?mail/i,
  /phone/i,
  /mobile/i,
  /address/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api_?key/i,
  /ssn/i,
  /social/i,
  /dob/i,
  /birth/i,
  /credit/i,
  /card/i,
  /iban/i,
  /ip_?address/i
];

export function parseSchemaNotes(input = "") {
  const schema = {
    tables: new Map(),
    rowNotes: new Map(),
    sensitiveHints: new Set(),
    raw: input
  };

  parseRowNotes(input, schema);
  parseSensitiveHints(input, schema);
  parseCreateTables(input, schema);
  parseIndexes(input, schema);
  applyInferredSensitivity(schema);

  return schema;
}

export function tableList(schema) {
  return [...schema.tables.values()];
}

export function lookupTable(schema, identifier) {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return null;

  if (schema.tables.has(normalized)) return schema.tables.get(normalized);

  const tail = normalized.split(".").at(-1);
  return [...schema.tables.values()].find((table) => table.name.split(".").at(-1) === tail) ?? null;
}

export function lookupColumn(table, columnName) {
  if (!table) return null;
  const normalized = normalizeIdentifier(columnName);
  return table.columns.get(normalized) ?? null;
}

export function resolveAlias(ast, qualifier) {
  const normalized = normalizeIdentifier(qualifier);
  return ast.aliases?.get(normalized) ?? normalized;
}

export function sourceStats(ast, schema) {
  const sources = [...ast.sources, ...ast.joins.map((join) => join.source)];

  return sources.map((source) => {
    const table = lookupTable(schema, source.name);
    return {
      source,
      table,
      rows: table?.rowCount ?? schema.rowNotes.get(source.name) ?? source.defaultRows ?? 10000
    };
  });
}

function ensureTable(schema, name, displayName = name) {
  const normalized = normalizeIdentifier(name);
  if (!schema.tables.has(normalized)) {
    schema.tables.set(normalized, {
      name: normalized,
      displayName,
      columns: new Map(),
      indexes: [],
      foreignKeys: [],
      primaryKey: [],
      rowCount: schema.rowNotes.get(normalized) ?? null
    });
  }
  return schema.tables.get(normalized);
}

function parseCreateTables(input, schema) {
  const tableRegex = /create\s+(?:temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"\[\]\w.]+)\s*\(([\s\S]*?)\)\s*;?/gi;
  let match;

  while ((match = tableRegex.exec(input))) {
    const displayName = unwrapIdentifier(match[1]);
    const table = ensureTable(schema, displayName, displayName);
    const bodyTokens = tokenize(match[2]);

    for (const group of splitTopLevel(bodyTokens)) {
      const text = tokensToText(group).trim();
      if (!text) continue;
      const first = group[0]?.normalized;

      if (["primary", "foreign", "constraint", "unique", "check"].includes(first)) {
        parseTableConstraint(text, table);
        continue;
      }

      const columnName = normalizeIdentifier(group[0]?.value ?? "");
      if (!columnName) continue;
      const type = inferColumnType(group.slice(1));
      const column = {
        name: columnName,
        displayName: unwrapIdentifier(group[0]?.value ?? columnName),
        type,
        nullable: !/\bnot\s+null\b/i.test(text) && !/\bprimary\s+key\b/i.test(text),
        primaryKey: /\bprimary\s+key\b/i.test(text),
        unique: /\bunique\b/i.test(text),
        references: parseReference(text),
        sensitive: false
      };

      if (column.primaryKey) {
        table.primaryKey = [...new Set([...table.primaryKey, column.name])];
      }
      if (column.references) {
        table.foreignKeys.push({ column: column.name, ...column.references });
      }

      table.columns.set(column.name, column);
    }
  }
}

function parseTableConstraint(text, table) {
  const primary = text.match(/primary\s+key\s*\(([^)]+)\)/i);
  if (primary) {
    table.primaryKey = splitColumnList(primary[1]);
    for (const column of table.primaryKey) {
      const existing = table.columns.get(column);
      if (existing) existing.primaryKey = true;
    }
  }

  const foreign = text.match(/foreign\s+key\s*\(([^)]+)\)\s+references\s+([`"\[\]\w.]+)\s*\(([^)]+)\)/i);
  if (foreign) {
    const columns = splitColumnList(foreign[1]);
    const referenceTable = normalizeIdentifier(foreign[2]);
    const referenceColumns = splitColumnList(foreign[3]);
    for (const column of columns) {
      table.foreignKeys.push({ column, table: referenceTable, columns: referenceColumns });
    }
  }
}

function parseIndexes(input, schema) {
  const indexRegex = /create\s+(unique\s+)?index\s+(?:[`"\[\]\w.]+\s+)?on\s+([`"\[\]\w.]+)\s*\(([^)]+)\)/gi;
  let match;

  while ((match = indexRegex.exec(input))) {
    const table = ensureTable(schema, match[2], unwrapIdentifier(match[2]));
    table.indexes.push({
      unique: Boolean(match[1]),
      columns: splitColumnList(match[3])
    });
  }
}

function parseRowNotes(input, schema) {
  const rowRegex = /(?:--|#)?\s*rows?\s*:\s*([^\n]+)/gi;
  let match;

  while ((match = rowRegex.exec(input))) {
    const pairs = match[1].split(/[,;]/);
    for (const pair of pairs) {
      const parts = pair.split(/=|:/);
      if (parts.length < 2) continue;
      const table = normalizeIdentifier(parts[0]);
      const count = Number(parts[1].replace(/[_\s]/g, ""));
      if (table && Number.isFinite(count)) {
        schema.rowNotes.set(table, count);
      }
    }
  }
}

function parseSensitiveHints(input, schema) {
  const hintRegex = /(?:--|#)?\s*sensitive\s*:\s*([^\n]+)/gi;
  let match;

  while ((match = hintRegex.exec(input))) {
    for (const part of match[1].split(/[,;]/)) {
      const hint = normalizeIdentifier(part);
      if (hint) schema.sensitiveHints.add(hint);
    }
  }
}

function applyInferredSensitivity(schema) {
  for (const table of schema.tables.values()) {
    for (const column of table.columns.values()) {
      const qualified = `${table.name}.${column.name}`;
      column.sensitive = schema.sensitiveHints.has(qualified)
        || schema.sensitiveHints.has(column.name)
        || SENSITIVE_PATTERNS.some((pattern) => pattern.test(column.name));
    }
  }
}

function inferColumnType(tokens) {
  const parts = [];

  for (const token of tokens) {
    if (CONSTRAINT_WORDS.has(token.normalized)) break;
    parts.push(token);
  }

  return compactIdentifier(parts).replace(/\s*\(\s*/g, "(").replace(/\s*\)\s*/g, ")") || "unknown";
}

function parseReference(text) {
  const match = text.match(/\breferences\s+([`"\[\]\w.]+)\s*(?:\(([^)]+)\))?/i);
  if (!match) return null;

  return {
    table: normalizeIdentifier(match[1]),
    columns: match[2] ? splitColumnList(match[2]) : []
  };
}

function splitColumnList(input) {
  return input
    .split(",")
    .map((column) => normalizeIdentifier(column))
    .filter(Boolean);
}

function unwrapIdentifier(identifier) {
  return identifier
    .trim()
    .replace(/^\[([\s\S]*)\]$/, "$1")
    .replace(/^`([\s\S]*)`$/, "$1")
    .replace(/^"([\s\S]*)"$/, "$1");
}
