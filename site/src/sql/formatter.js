import { tokenize } from "./tokenizer.js";

const CLAUSE_STARTERS = new Set(["with", "select", "from", "where", "having", "limit", "offset"]);
const COMPOUND_STARTERS = new Map([
  ["group", "GROUP BY"],
  ["order", "ORDER BY"]
]);
const JOIN_PREFIXES = new Set(["join", "inner", "left", "right", "full", "cross"]);

export function formatSql(sql) {
  const tokens = tokenize(sql);
  if (tokens.length === 0) return "";

  const lines = [];
  let current = "";
  let depth = 0;
  let indent = 0;
  let lastTokenLine = tokens[0]?.line ?? 1;

  const pushLine = () => {
    const text = current.trim();
    if (text) lines.push(`${"  ".repeat(Math.max(0, indent))}${text}`);
    current = "";
  };

  const append = (value) => {
    if (!current) {
      current = value;
    } else if (value === "," || value === ")" || value === ";") {
      current += value;
    } else if (current.endsWith("(") || value === "." || current.endsWith(".")) {
      current += value;
    } else if (value === "(" && /[A-Za-z0-9_*]$/.test(current)) {
      current += value;
    } else {
      current += ` ${value}`;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const lower = token.normalized;

    if (token.line > lastTokenLine && current.trim()) {
      pushLine();
      indent = Math.min(6, Math.max(0, depth));
    }
    lastTokenLine = token.line;

    if (token.value === "(") {
      append(token.value);
      depth += 1;
      continue;
    }

    if (token.value === ")") {
      depth = Math.max(0, depth - 1);
      append(token.value);
      continue;
    }

    if (depth === 0 && COMPOUND_STARTERS.has(lower) && next?.normalized === "by") {
      pushLine();
      append(COMPOUND_STARTERS.get(lower));
      index += 1;
      continue;
    }

    if (depth === 0 && CLAUSE_STARTERS.has(lower)) {
      pushLine();
      indent = lower === "select" ? 0 : 0;
      append(lower.toUpperCase());
      continue;
    }

    if (depth === 0 && lower !== "join" && JOIN_PREFIXES.has(lower) && next?.normalized === "join") {
      pushLine();
      append(`${token.value.toUpperCase()} JOIN`);
      index += 1;
      continue;
    }

    if (depth === 0 && lower === "join") {
      pushLine();
      append("JOIN");
      continue;
    }

    if (depth === 0 && token.value === ",") {
      append(",");
      pushLine();
      indent = 1;
      continue;
    }

    if (depth === 0 && (lower === "and" || lower === "or")) {
      pushLine();
      indent = 1;
      append(lower.toUpperCase());
      continue;
    }

    append(keywordCase(token));
  }

  pushLine();
  return lines.join("\n");
}

function keywordCase(token) {
  if (token.type !== "word") return token.value;
  const lower = token.normalized;
  if ([
    "as",
    "between",
    "case",
    "else",
    "end",
    "in",
    "is",
    "like",
    "not",
    "null",
    "on",
    "using",
    "when",
    "then"
  ].includes(lower)) {
    return lower.toUpperCase();
  }
  return token.value;
}
