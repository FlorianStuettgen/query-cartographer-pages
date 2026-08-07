const KEYWORDS = new Set([
  "all",
  "and",
  "as",
  "asc",
  "between",
  "by",
  "case",
  "cast",
  "cross",
  "delete",
  "desc",
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
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "lateral",
  "left",
  "like",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "over",
  "partition",
  "right",
  "select",
  "set",
  "then",
  "union",
  "update",
  "using",
  "when",
  "where",
  "with"
]);

const MULTI_CHAR_OPERATORS = [
  "::",
  "->>",
  "->",
  ">=",
  "<=",
  "<>",
  "!=",
  "||",
  "&&",
  "==",
  "=>"
];

export function stripComments(sql) {
  let output = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        output += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < sql.length) {
        output += "  ";
        index += 2;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

export function tokenize(sql) {
  const cleanSql = stripComments(sql);
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const push = (type, value, startLine, startColumn) => {
    const normalized = type === "word" ? value.toLowerCase() : value;
    tokens.push({ type, value, normalized, line: startLine, column: startColumn });
  };

  const advance = (count = 1) => {
    for (let step = 0; step < count; step += 1) {
      if (cleanSql[index] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  while (index < cleanSql.length) {
    const char = cleanSql[index];
    const startLine = line;
    const startColumn = column;

    if (/\s/.test(char)) {
      advance();
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = quote;
      advance();

      while (index < cleanSql.length) {
        value += cleanSql[index];
        if (cleanSql[index] === quote) {
          if (cleanSql[index + 1] === quote) {
            value += cleanSql[index + 1];
            advance(2);
            continue;
          }
          advance();
          break;
        }
        advance();
      }

      push(quote === "'" ? "string" : "identifier", value, startLine, startColumn);
      continue;
    }

    if (char === "[") {
      let value = char;
      advance();
      while (index < cleanSql.length) {
        value += cleanSql[index];
        if (cleanSql[index] === "]") {
          advance();
          break;
        }
        advance();
      }
      push("identifier", value, startLine, startColumn);
      continue;
    }

    if (/[0-9]/.test(char)) {
      let value = "";
      while (index < cleanSql.length && /[0-9._]/.test(cleanSql[index])) {
        value += cleanSql[index];
        advance();
      }
      push("number", value, startLine, startColumn);
      continue;
    }

    if (/[A-Za-z_@$#]/.test(char)) {
      let value = "";
      while (index < cleanSql.length && /[A-Za-z0-9_@$#]/.test(cleanSql[index])) {
        value += cleanSql[index];
        advance();
      }
      push("word", value, startLine, startColumn);
      continue;
    }

    const operator = MULTI_CHAR_OPERATORS.find((candidate) => cleanSql.startsWith(candidate, index));
    if (operator) {
      push("operator", operator, startLine, startColumn);
      advance(operator.length);
      continue;
    }

    if ("(),.;".includes(char)) {
      push("symbol", char, startLine, startColumn);
      advance();
      continue;
    }

    if ("+-*/%=<>".includes(char)) {
      push("operator", char, startLine, startColumn);
      advance();
      continue;
    }

    push("symbol", char, startLine, startColumn);
    advance();
  }

  return tokens;
}

export function isKeyword(token, keyword) {
  return token?.type === "word" && token.normalized === keyword.toLowerCase();
}

export function isClauseKeyword(token) {
  return token?.type === "word" && KEYWORDS.has(token.normalized);
}

export function tokenText(token) {
  return token?.value ?? "";
}

export function normalizeIdentifier(identifier) {
  if (!identifier) return "";
  const trimmed = identifier.trim();
  const unwrapped = trimmed
    .replace(/^\[([\s\S]*)\]$/, "$1")
    .replace(/^`([\s\S]*)`$/, "$1")
    .replace(/^"([\s\S]*)"$/, "$1");
  return unwrapped.toLowerCase();
}

export function compactIdentifier(tokens) {
  return tokensToText(tokens).replace(/\s*\.\s*/g, ".").trim();
}

export function tokensToText(tokens) {
  let output = "";

  for (const token of tokens) {
    const value = tokenText(token);
    const previous = output.at(-1);

    if (!output) {
      output = value;
      continue;
    }

    if ([",", ")", ";"].includes(value)) {
      output += value;
    } else if (value === ".") {
      output += value;
    } else if (previous === "." || previous === "(") {
      output += value;
    } else if (value === "(" && /[A-Za-z0-9_)\]]$/.test(previous)) {
      output += value;
    } else {
      output += ` ${value}`;
    }
  }

  return output;
}

export function splitTopLevel(tokens, delimiter = ",") {
  const groups = [];
  let depth = 0;
  let current = [];

  for (const token of tokens) {
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && token.value === delimiter) {
      groups.push(current);
      current = [];
      continue;
    }

    current.push(token);
  }

  if (current.length > 0 || tokens.length === 0) {
    groups.push(current);
  }

  return groups;
}

export function findTopLevelKeyword(tokens, keyword, start = 0) {
  let depth = 0;

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && isKeyword(token, keyword)) {
      return index;
    }
  }

  return -1;
}

export function findTopLevelSequence(tokens, sequence, start = 0) {
  let depth = 0;
  const normalized = sequence.map((part) => part.toLowerCase());

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);

    if (depth !== 0) continue;

    const matches = normalized.every((part, offset) => isKeyword(tokens[index + offset], part));
    if (matches) return index;
  }

  return -1;
}

export function sliceBetween(tokens, startIndex, endIndex) {
  const start = Math.max(0, startIndex);
  const end = endIndex === -1 ? tokens.length : Math.max(start, endIndex);
  return tokens.slice(start, end);
}

export function firstTopLevelIndex(tokens, candidates, start = 0) {
  const found = candidates
    .map((candidate) => {
      const parts = candidate.split(" ");
      const index = parts.length === 1
        ? findTopLevelKeyword(tokens, candidate, start)
        : findTopLevelSequence(tokens, parts, start);
      return { candidate, index };
    })
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);

  return found[0] ?? { candidate: null, index: -1 };
}

export function hasTopLevelKeyword(tokens, keyword) {
  return findTopLevelKeyword(tokens, keyword) >= 0;
}

export function tokenLowerText(tokens) {
  return tokens.map((token) => token.normalized ?? token.value.toLowerCase()).join(" ");
}
