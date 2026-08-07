import {
  compactIdentifier,
  findTopLevelKeyword,
  findTopLevelSequence,
  firstTopLevelIndex,
  hasTopLevelKeyword,
  isKeyword,
  normalizeIdentifier,
  sliceBetween,
  splitTopLevel,
  tokenize,
  tokenLowerText,
  tokensToText
} from "./tokenizer.js";

const CLAUSE_BOUNDARIES = ["where", "group by", "having", "order by", "limit", "offset", "union", "intersect", "except"];
const JOIN_MODIFIERS = new Set(["inner", "left", "right", "full", "cross", "outer", "natural"]);
const EXPRESSION_KEYWORDS = new Set([
  "and",
  "as",
  "between",
  "case",
  "cast",
  "else",
  "end",
  "false",
  "in",
  "is",
  "like",
  "not",
  "null",
  "or",
  "over",
  "then",
  "true",
  "when"
]);

export function parseSql(sql) {
  const tokens = tokenize(sql);
  const statementType = detectStatementType(tokens);

  if (statementType !== "select" && statementType !== "with") {
    return {
      sql,
      tokens,
      statementType,
      ctes: [],
      projections: [],
      sources: [],
      joins: [],
      predicates: [],
      groupBy: [],
      orderBy: [],
      limit: "",
      aliases: new Map(),
      unsupported: true
    };
  }

  const { ctes, mainTokens } = parseCtes(tokens);
  const statement = parseSelectTokens(mainTokens, ctes);

  return {
    sql,
    tokens,
    statementType,
    ctes,
    ...statement,
    unsupported: false
  };
}

function detectStatementType(tokens) {
  const first = tokens.find((token) => token.type === "word");
  return first?.normalized ?? "empty";
}

function parseCtes(tokens) {
  if (!isKeyword(tokens[0], "with")) {
    return { ctes: [], mainTokens: tokens };
  }

  const ctes = [];
  let index = 1;

  if (isKeyword(tokens[index], "recursive")) {
    index += 1;
  }

  while (index < tokens.length) {
    const nameToken = tokens[index];
    const name = normalizeIdentifier(nameToken?.value ?? "");
    index += 1;

    const columnTokens = [];
    if (tokens[index]?.value === "(") {
      const closeIndex = findMatchingParen(tokens, index);
      columnTokens.push(...tokens.slice(index + 1, closeIndex));
      index = closeIndex + 1;
    }

    if (isKeyword(tokens[index], "as")) {
      index += 1;
    }

    if (tokens[index]?.value !== "(") {
      break;
    }

    const bodyStart = index;
    const bodyEnd = findMatchingParen(tokens, bodyStart);
    const bodyTokens = tokens.slice(bodyStart + 1, bodyEnd);
    const columns = splitTopLevel(columnTokens).map((group) => compactIdentifier(group)).filter(Boolean);
    const inner = bodyTokens.length ? parseSelectTokens(bodyTokens, []) : emptyStatement();

    ctes.push({
      name,
      displayName: nameToken?.value ?? name,
      columns,
      sql: tokensToText(bodyTokens),
      span: tokenSpan(tokens.slice(Math.max(0, index - 1), bodyEnd + 1)),
      statement: inner
    });

    index = bodyEnd + 1;

    if (tokens[index]?.value === ",") {
      index += 1;
      continue;
    }

    break;
  }

  return { ctes, mainTokens: tokens.slice(index) };
}

function parseSelectTokens(tokens, ctes = []) {
  const selectIndex = findTopLevelKeyword(tokens, "select");
  if (selectIndex < 0) return emptyStatement(tokens);

  const fromIndex = findTopLevelKeyword(tokens, "from", selectIndex + 1);
  const selectEnd = fromIndex >= 0 ? fromIndex : tokens.length;
  const selectTokens = sliceBetween(tokens, selectIndex + 1, selectEnd);
  const distinct = hasTopLevelKeyword(selectTokens, "distinct");
  const projectionTokens = distinct ? selectTokens.filter((token) => !isKeyword(token, "distinct")) : selectTokens;
  const projections = parseProjections(projectionTokens);

  const afterFrom = fromIndex >= 0 ? fromIndex + 1 : tokens.length;
  const firstBoundary = firstTopLevelIndex(tokens, CLAUSE_BOUNDARIES, afterFrom);
  const fromEnd = firstBoundary.index >= 0 ? firstBoundary.index : tokens.length;
  const fromTokens = fromIndex >= 0 ? sliceBetween(tokens, afterFrom, fromEnd) : [];
  const { sources, joins } = parseFrom(fromTokens, ctes);

  const whereTokens = clauseTokens(tokens, "where", ["group by", "having", "order by", "limit", "offset", "union"]);
  const groupTokens = clauseTokens(tokens, "group by", ["having", "order by", "limit", "offset", "union"]);
  const havingTokens = clauseTokens(tokens, "having", ["order by", "limit", "offset", "union"]);
  const orderTokens = clauseTokens(tokens, "order by", ["limit", "offset", "union"]);
  const limitTokens = clauseTokens(tokens, "limit", ["offset", "union"]);
  const offsetTokens = clauseTokens(tokens, "offset", ["union"]);

  const aliases = new Map();
  for (const source of sources) {
    aliases.set(source.alias ?? source.name, source.name);
  }
  for (const join of joins) {
    aliases.set(join.source.alias ?? join.source.name, join.source.name);
  }

  return {
    distinct,
    projections,
    sources,
    joins,
    predicates: splitPredicates(whereTokens),
    having: splitPredicates(havingTokens),
    groupBy: splitTopLevel(groupTokens).map(parseExpression).filter((entry) => entry.text),
    orderBy: splitTopLevel(orderTokens).map(parseExpression).filter((entry) => entry.text),
    limit: tokensToText(limitTokens).trim(),
    offset: tokensToText(offsetTokens).trim(),
    aliases,
    clauses: {
      select: tokensToText(selectTokens),
      from: tokensToText(fromTokens),
      where: tokensToText(whereTokens),
      groupBy: tokensToText(groupTokens),
      having: tokensToText(havingTokens),
      orderBy: tokensToText(orderTokens),
      limit: tokensToText(limitTokens),
      offset: tokensToText(offsetTokens)
    }
  };
}

function emptyStatement(tokens = []) {
  return {
    distinct: false,
    projections: [],
    sources: [],
    joins: [],
    predicates: [],
    having: [],
    groupBy: [],
    orderBy: [],
    limit: "",
    offset: "",
    aliases: new Map(),
    clauses: {},
    tokens
  };
}

function clauseTokens(tokens, clause, endings) {
  const parts = clause.split(" ");
  const start = parts.length === 1
    ? findTopLevelKeyword(tokens, clause)
    : findTopLevelSequence(tokens, parts);

  if (start < 0) return [];
  const contentStart = start + parts.length;
  const end = firstTopLevelIndex(tokens, endings, contentStart);
  return sliceBetween(tokens, contentStart, end.index);
}

function parseProjections(tokens) {
  return splitTopLevel(tokens)
    .map((group, index) => {
      const aliasInfo = extractAlias(group);
      const expressionTokens = aliasInfo.expressionTokens;
      const text = tokensToText(expressionTokens).trim();
      return {
        index,
        text,
        alias: aliasInfo.alias,
        wildcard: isWildcardProjection(expressionTokens),
        aggregate: /\b(count|sum|avg|min|max|string_agg|array_agg|json_agg|bool_or|bool_and)\s*\(/i.test(text),
        windowed: /\bover\s*\(/i.test(text),
        references: extractReferences(expressionTokens),
        span: tokenSpan(expressionTokens)
      };
    })
    .filter((projection) => projection.text);
}

function isWildcardProjection(tokens) {
  const trimmed = tokens.filter((token) => token.value !== ";");
  if (trimmed.length === 1) return trimmed[0].value === "*";
  if (trimmed.length === 3 && trimmed[1].value === "." && trimmed[2].value === "*") {
    return ["word", "identifier"].includes(trimmed[0].type);
  }
  return false;
}

function parseFrom(tokens, ctes) {
  const sources = [];
  const joins = [];
  let index = 0;

  const firstJoin = findNextJoinStart(tokens, index);
  const baseTokens = firstJoin >= 0 ? tokens.slice(0, firstJoin) : tokens;
  const baseSource = parseRelation(baseTokens, ctes, "base");
  if (baseSource.name) sources.push(baseSource);
  index = firstJoin >= 0 ? firstJoin : tokens.length;

  while (index < tokens.length) {
    const joinStart = findNextJoinStart(tokens, index);
    if (joinStart < 0) break;

    const joinKeyword = findJoinKeyword(tokens, joinStart);
    const typeTokens = tokens.slice(joinStart, joinKeyword + 1);
    const joinType = normalizeJoinType(typeTokens);
    const relationStart = joinKeyword + 1;
    const conditionStart = findJoinConditionStart(tokens, relationStart);
    const nextJoin = findNextJoinStart(tokens, relationStart + 1);
    const relationEnd = conditionStart >= 0 ? conditionStart : nextJoin >= 0 ? nextJoin : tokens.length;
    const relationTokens = tokens.slice(relationStart, relationEnd);
    const source = parseRelation(relationTokens, ctes, "join");

    let conditionTokens = [];
    let conditionKind = "";
    let joinEnd = relationEnd;

    if (conditionStart >= 0 && (nextJoin < 0 || conditionStart < nextJoin)) {
      conditionKind = tokens[conditionStart].normalized;
      const conditionContentStart = conditionStart + 1;
      const conditionEnd = nextJoin >= 0 ? nextJoin : tokens.length;
      conditionTokens = tokens.slice(conditionContentStart, conditionEnd);
      joinEnd = conditionEnd;
    } else if (nextJoin >= 0) {
      joinEnd = nextJoin;
    }

    joins.push({
      index: joins.length,
      type: joinType,
      source,
      conditionKind,
      condition: tokensToText(conditionTokens).trim(),
      conditionTokens,
      references: extractReferences(conditionTokens),
      span: tokenSpan(tokens.slice(joinStart, joinEnd)),
      conditionSpan: tokenSpan(conditionTokens),
      risky: joinType === "cross" || conditionTokens.length === 0
    });

    index = joinEnd;
  }

  return { sources, joins };
}

function parseRelation(tokens, ctes, role) {
  const trimmed = trimPunctuation(tokens);
  if (trimmed.length === 0) return { name: "", alias: "", type: "unknown", role, span: null };

  if (trimmed[0].value === "(") {
    const closeIndex = findMatchingParen(trimmed, 0);
    const innerTokens = trimmed.slice(1, closeIndex);
    const aliasTokens = trimmed.slice(closeIndex + 1).filter((token) => !isKeyword(token, "as"));
    const alias = compactIdentifier(aliasTokens.slice(0, 1));
    return {
      name: alias || "subquery",
      displayName: alias || "subquery",
      alias,
      type: "subquery",
      role,
      sql: tokensToText(innerTokens),
      span: tokenSpan(trimmed),
      statement: parseSelectTokens(innerTokens, ctes)
    };
  }

  const asIndex = trimmed.findIndex((token) => isKeyword(token, "as"));
  let nameTokens = trimmed;
  let alias = "";

  if (asIndex >= 0) {
    nameTokens = trimmed.slice(0, asIndex);
    alias = compactIdentifier(trimmed.slice(asIndex + 1, asIndex + 2));
  } else {
    const nameEnd = findRelationNameEnd(trimmed);
    nameTokens = trimmed.slice(0, nameEnd);
    alias = compactIdentifier(trimmed.slice(nameEnd, nameEnd + 1));
  }

  const name = compactIdentifier(nameTokens);
  const normalizedName = normalizeIdentifier(name);
  const cteNames = new Set(ctes.map((cte) => cte.name));

  return {
    name: normalizedName,
    displayName: name || normalizedName,
    alias: normalizeIdentifier(alias),
    type: cteNames.has(normalizedName) ? "cte" : "table",
    role,
    span: tokenSpan(trimmed)
  };
}

function trimPunctuation(tokens) {
  let start = 0;
  let end = tokens.length;
  while (tokens[start]?.value === ",") start += 1;
  while (tokens[end - 1]?.value === ",") end -= 1;
  return tokens.slice(start, end);
}

function findRelationNameEnd(tokens) {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const previous = tokens[index - 1];

    if (token.value === ".") {
      index += 1;
      continue;
    }

    if (index > 0 && previous?.value !== "." && token.type === "word") {
      return index;
    }

    if (token.type === "word" || token.type === "identifier") {
      index += 1;
      if (next?.value === ".") continue;
      return index;
    }

    return index + 1;
  }

  return tokens.length;
}

function extractAlias(tokens) {
  const asIndex = findTopLevelKeyword(tokens, "as");
  if (asIndex >= 0) {
    return {
      expressionTokens: tokens.slice(0, asIndex),
      alias: compactIdentifier(tokens.slice(asIndex + 1))
    };
  }

  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const before = tokens[tokens.length - 2];
    const lastIsAlias = ["word", "identifier"].includes(last.type)
      && before?.value !== "."
      && !EXPRESSION_KEYWORDS.has(last.normalized)
      && !["operator", "symbol"].includes(before?.type);

    if (lastIsAlias) {
      return {
        expressionTokens: tokens.slice(0, -1),
        alias: normalizeIdentifier(last.value)
      };
    }
  }

  return { expressionTokens: tokens, alias: "" };
}

function parseExpression(tokens) {
  const text = tokensToText(tokens).trim();
  return {
    text,
    references: extractReferences(tokens),
    aggregate: /\b(count|sum|avg|min|max)\s*\(/i.test(text),
    span: tokenSpan(tokens)
  };
}

function tokenSpan(tokens) {
  const positioned = tokens.filter((token) => Number.isFinite(token.line));
  if (positioned.length === 0) return null;

  const first = positioned[0];
  const last = positioned[positioned.length - 1];
  return {
    lineStart: first.line,
    columnStart: first.column,
    lineEnd: last.line,
    columnEnd: last.column + String(last.value ?? "").length
  };
}

function splitPredicates(tokens) {
  const predicates = [];
  let depth = 0;
  let current = [];

  for (const token of tokens) {
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && isKeyword(token, "and")) {
      const entry = parseExpression(current);
      if (entry.text) predicates.push(entry);
      current = [];
      continue;
    }

    current.push(token);
  }

  const entry = parseExpression(current);
  if (entry.text) predicates.push(entry);
  return predicates;
}

function extractReferences(tokens) {
  const references = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const dot = tokens[index + 1];
    const next = tokens[index + 2];

    if ((current.type === "word" || current.type === "identifier") && dot?.value === "." && next) {
      references.push({
        qualifier: normalizeIdentifier(current.value),
        column: normalizeIdentifier(next.value),
        text: `${current.value}.${next.value}`
      });
      index += 2;
      continue;
    }
  }

  return references;
}

function normalizeJoinType(tokens) {
  const lower = tokenLowerText(tokens);
  if (lower.includes("cross")) return "cross";
  if (lower.includes("left")) return "left";
  if (lower.includes("right")) return "right";
  if (lower.includes("full")) return "full";
  if (lower.includes("inner")) return "inner";
  if (lower.includes("natural")) return "natural";
  return "inner";
}

function findNextJoinStart(tokens, start) {
  let depth = 0;

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;

    if (isKeyword(token, "join")) return index;
    if (JOIN_MODIFIERS.has(token.normalized) && findJoinKeyword(tokens, index) >= 0) {
      return index;
    }
  }

  return -1;
}

function findJoinKeyword(tokens, start) {
  for (let index = start; index < Math.min(tokens.length, start + 4); index += 1) {
    if (isKeyword(tokens[index], "join")) return index;
  }
  return -1;
}

function findJoinConditionStart(tokens, start) {
  let depth = 0;

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;

    if (isKeyword(token, "on") || isKeyword(token, "using")) {
      return index;
    }

    if (findNextJoinStart(tokens, index) === index) {
      return -1;
    }
  }

  return -1;
}

function findMatchingParen(tokens, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return tokens.length - 1;
}
