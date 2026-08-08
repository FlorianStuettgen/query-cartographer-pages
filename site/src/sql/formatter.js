import { tokenize } from "./tokenizer.js";

const CLAUSE_STARTERS = new Set(["with", "select", "from", "where", "having", "limit", "offset"]);
const COMPOUND_STARTERS = new Map([
  ["group", "GROUP BY"],
  ["order", "ORDER BY"]
]);
const JOIN_PREFIXES = new Set(["join", "inner", "left", "right", "full", "cross"]);

export function formatSql(sql) {
  return formatSqlWithLineMap(sql).formattedSql;
}

export function formatSqlWithLineMap(sql) {
  const tokens = tokenize(sql);
  if (tokens.length === 0) return { formattedSql: "", lineMap: [] };

  const lines = [];
  const lineMap = [];
  let current = "";
  let currentLineRanges = [null];
  let depth = 0;
  let indent = 0;
  let lastTokenLine = tokens[0]?.line ?? 1;

  const pushLine = () => {
    const text = current.trim();
    if (text) {
      const trimStart = current.length - current.trimStart().length;
      const firstMappedLine = countLineBreaks(current.slice(0, trimStart));
      const formattedLines = text.split("\n");
      lines.push(`${"  ".repeat(Math.max(0, indent))}${text}`);
      formattedLines.forEach((unused, index) => {
        const range = currentLineRanges[firstMappedLine + index];
        if (!range) {
          throw new Error(`Formatter emitted line ${lineMap.length + 1} without raw SQL coordinates`);
        }
        lineMap.push({
          formattedLine: lineMap.length + 1,
          rawLineStart: range.rawLineStart,
          rawLineEnd: range.rawLineEnd
        });
      });
    }
    current = "";
    currentLineRanges = [null];
  };

  const appendFragment = (value, sourceTokens = []) => {
    const fragments = value.split("\n");
    const ranges = fragmentRawRanges(value, sourceTokens);
    fragments.forEach((fragment, index) => {
      current += fragment;
      currentLineRanges[currentLineRanges.length - 1] = mergeRawRanges(
        currentLineRanges.at(-1),
        ranges[index]
      );
      if (index < fragments.length - 1) {
        current += "\n";
        currentLineRanges.push(null);
      }
    });
  };

  const append = (value, sourceTokens) => {
    let separator = "";
    if (!current) {
      separator = "";
    } else if (value === "," || value === ")" || value === ";") {
      separator = "";
    } else if (current.endsWith("(") || value === "." || current.endsWith(".")) {
      separator = "";
    } else if (value === "(" && /[A-Za-z0-9_*]$/.test(current)) {
      separator = "";
    } else {
      separator = " ";
    }
    appendFragment(separator);
    appendFragment(value, sourceTokens);
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
      append(token.value, [token]);
      depth += 1;
      continue;
    }

    if (token.value === ")") {
      depth = Math.max(0, depth - 1);
      append(token.value, [token]);
      continue;
    }

    if (depth === 0 && COMPOUND_STARTERS.has(lower) && next?.normalized === "by") {
      pushLine();
      append(COMPOUND_STARTERS.get(lower), [token, next]);
      index += 1;
      continue;
    }

    if (depth === 0 && CLAUSE_STARTERS.has(lower)) {
      pushLine();
      indent = lower === "select" ? 0 : 0;
      append(lower.toUpperCase(), [token]);
      continue;
    }

    if (depth === 0 && lower !== "join" && JOIN_PREFIXES.has(lower) && next?.normalized === "join") {
      pushLine();
      append(`${token.value.toUpperCase()} JOIN`, [token, next]);
      index += 1;
      continue;
    }

    if (depth === 0 && lower === "join") {
      pushLine();
      append("JOIN", [token]);
      continue;
    }

    if (depth === 0 && token.value === ",") {
      append(",", [token]);
      pushLine();
      indent = 1;
      continue;
    }

    if (depth === 0 && (lower === "and" || lower === "or")) {
      pushLine();
      indent = 1;
      append(lower.toUpperCase(), [token]);
      continue;
    }

    append(keywordCase(token), [token]);
  }

  pushLine();
  return { formattedSql: lines.join("\n"), lineMap };
}

function fragmentRawRanges(value, sourceTokens) {
  const lineCount = countLineBreaks(value) + 1;
  if (sourceTokens.length === 0) return Array(lineCount).fill(null);

  if (sourceTokens.length === 1 && countLineBreaks(sourceTokens[0].value) === lineCount - 1) {
    return Array.from({ length: lineCount }, (unused, index) => ({
      rawLineStart: sourceTokens[0].line + index,
      rawLineEnd: sourceTokens[0].line + index
    }));
  }

  const range = sourceTokens.reduce((combined, token) => mergeRawRanges(combined, {
    rawLineStart: token.line,
    rawLineEnd: token.line + countLineBreaks(token.value)
  }), null);
  return Array.from({ length: lineCount }, () => range);
}

function mergeRawRanges(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    rawLineStart: Math.min(left.rawLineStart, right.rawLineStart),
    rawLineEnd: Math.max(left.rawLineEnd, right.rawLineEnd)
  };
}

function countLineBreaks(value) {
  let count = 0;
  for (const character of value) {
    if (character === "\n") count += 1;
  }
  return count;
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
