import { lookupColumn, lookupTable, resolveAlias, sourceStats } from "./schema.js";
import { dialectFindings } from "./dialects.js";
import { tokenize, tokenLowerText } from "./tokenizer.js";
import { IDENTITY_NAMESPACE, IDENTITY_SCHEMA_VERSION, attachStableIdentity, canonicalClauseText } from "./identity.js";

const SEVERITY_WEIGHT = {
  high: 30,
  medium: 14,
  low: 6,
  info: 2
};

export function diagnose(ast, schema, dialect = null) {
  const findings = [];

  if (!ast.sql?.trim()) {
    return summarize([
      finding("info", "readiness", "No SQL loaded", "Paste or load a query to build an atlas.", "", "")
    ]);
  }

  if (ast.unsupported) {
    findings.push(finding(
      "high",
      "safety",
      "Statement is outside read-only analysis",
      `The first statement appears to be ${ast.statementType.toUpperCase()}. Query Cartographer analyzes structure, but it does not execute or approve mutating SQL.`,
      ast.statementType,
      "Review write statements manually and require a transaction, WHERE clause, backup, and rollback plan."
    ));
    return summarize(findings);
  }

  inspectSyntaxHealth(ast, findings);
  inspectProjection(ast, schema, findings);
  inspectJoins(ast, schema, findings);
  inspectPredicates(ast, schema, findings);
  inspectBooleanLogic(ast, findings);
  inspectGrouping(ast, findings);
  inspectOrdering(ast, findings);
  inspectWindowing(ast, findings);
  inspectReviewFragility(ast, findings);
  inspectSchemaCoverage(ast, schema, findings);
  inspectCtes(ast, findings);
  findings.push(...dialectFindings(ast, dialect || { primary: "ansi", label: "ANSI-ish", confidence: "low", signals: [], alternatives: [] }));

  if (findings.length === 0) {
    findings.push(finding(
      "info",
      "readiness",
      "No major static hazards detected",
      "The query still deserves runtime validation with real plans and representative data.",
      "",
      "Compare this atlas with EXPLAIN output before production rollout."
    ));
  }

  return summarize(findings);
}

function inspectSyntaxHealth(ast, findings) {
  const sql = ast.sql || "";
  const issues = scanSyntaxDamage(sql);

  for (const issue of issues.slice(0, 12)) {
    findings.push(finding(
      issue.severity,
      "syntax",
      issue.title,
      issue.detail,
      issue.evidence,
      issue.suggestion
    ));
  }

  if (issues.length > 12) {
    findings.push(finding(
      "medium",
      "syntax",
      "SQL has additional syntax damage",
      `${issues.length - 12} more syntax-health issue${issues.length - 12 === 1 ? "" : "s"} were suppressed so the review stays usable.`,
      "",
      "Use the Query Lens heat markers to fix the first blocking syntax issues, then re-run the review."
    ));
  }

  if (ast.projections.length === 0 && /\bselect\b/i.test(sql)) {
    findings.push(finding(
      "high",
      "syntax",
      "SELECT list could not be recovered",
      "The parser found SELECT but could not recover output fields, usually because the statement is incomplete before FROM.",
      lineWithKeyword(sql, "select"),
      "Fix the SELECT list first; downstream lineage and metric review depend on recovered projections."
    ));
  }

  if (ast.sources.length === 0 && /\bfrom\b/i.test(sql)) {
    findings.push(finding(
      "high",
      "syntax",
      "FROM source could not be recovered",
      "The parser found FROM but could not recover a base relation, which makes lineage and row-flow estimates unreliable.",
      lineWithKeyword(sql, "from"),
      "Repair the first FROM relation or CTE boundary before trusting source-level diagnostics."
    ));
  }
}

function scanSyntaxDamage(sql) {
  const issues = [];
  const lines = String(sql || "").split(/\r?\n/);
  const parens = [];
  let quote = null;
  let quoteLine = 0;
  let blockCommentLine = 0;
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length) {
      const char = line[index];
      const next = line[index + 1];

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }

      if (quote) {
        if (char === quote) {
          if (line[index + 1] === quote) {
            index += 2;
            continue;
          }
          quote = null;
        }
        index += 1;
        continue;
      }

      if (char === "-" && next === "-") break;
      if (char === "/" && next === "*") {
        inBlockComment = true;
        blockCommentLine = lineIndex + 1;
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        quoteLine = lineIndex + 1;
        index += 1;
        continue;
      }
      if (char === "(") {
        parens.push({ line: lineIndex + 1, evidence: line.trim() });
      } else if (char === ")") {
        const opener = parens.pop();
        if (!opener) {
          issues.push({
            severity: "high",
            title: "Closing parenthesis has no opener",
            detail: `Line ${lineIndex + 1} closes a parenthesis that has no visible matching opener.`,
            evidence: line.trim(),
            suggestion: "Remove the extra closing parenthesis or restore the missing opening expression."
          });
        }
      }
      index += 1;
    }
  }

  if (quote) {
    const kind = quote === "'" ? "string literal" : "quoted identifier";
    issues.push({
      severity: "high",
      title: `Unterminated ${kind}`,
      detail: `A ${kind} starts on line ${quoteLine} and never closes, so everything after it may be parsed incorrectly.`,
      evidence: lines[quoteLine - 1]?.trim() || "",
      suggestion: "Close the quote or remove the unfinished fragment before reviewing lineage."
    });
  }

  if (inBlockComment) {
    issues.push({
      severity: "medium",
      title: "Unclosed block comment",
      detail: `A block comment starts on line ${blockCommentLine} and never closes.`,
      evidence: lines[blockCommentLine - 1]?.trim() || "/*",
      suggestion: "Close the block comment so later SQL is not hidden from review."
    });
  }

  for (const opener of parens.slice(-8)) {
    issues.push({
      severity: "high",
      title: "Opening parenthesis has no closer",
      detail: `Line ${opener.line} opens a parenthesis that is still unclosed at the end of the model.`,
      evidence: opener.evidence,
      suggestion: "Close the expression, CTE, function call, or subquery before trusting downstream lineage."
    });
  }

  issues.push(...scanClauseDamage(lines));
  return issues;
}

function scanClauseDamage(lines) {
  const issues = [];
  const clausePattern = /\b(select|from|where|join|on|group\s+by|having|order\s+by|qualify|limit|union)\b/i;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (!trimmed || trimmed.startsWith("--")) return;

    if (/\bjoin\s*(where|group\s+by|having|order\s+by|limit|union)\b/i.test(lower)) {
      issues.push({
        severity: "high",
        title: "JOIN appears to be missing a relation",
        detail: `Line ${index + 1} moves from JOIN into another clause without a joined source.`,
        evidence: trimmed,
        suggestion: "Add the joined table/subquery before ON or the next clause."
      });
    }

    if (/\bfrom\s*(where|group\s+by|having|order\s+by|limit|union)\b/i.test(lower)) {
      issues.push({
        severity: "high",
        title: "FROM appears to be missing a relation",
        detail: `Line ${index + 1} moves from FROM into another clause without a base source.`,
        evidence: trimmed,
        suggestion: "Add the base table, CTE, or subquery after FROM."
      });
    }

    if (/\bon\s*(where|group\s+by|having|order\s+by|limit|union)\b/i.test(lower)) {
      issues.push({
        severity: "high",
        title: "ON appears to be missing a predicate",
        detail: `Line ${index + 1} starts a join predicate but reaches the next clause immediately.`,
        evidence: trimmed,
        suggestion: "Add the join predicate or move the clause boundary."
      });
    }

    if (clausePattern.test(lower) && /,\s*$/.test(trimmed)) {
      issues.push({
        severity: "medium",
        title: "Clause line ends with a dangling comma",
        detail: `Line ${index + 1} ends with a comma, which often means a pasted field or source is missing.`,
        evidence: trimmed,
        suggestion: "Confirm the next line contains the intended expression and no clause boundary was skipped."
      });
    }

    if (/,\s*$/.test(trimmed)) {
      const nextLine = lines.slice(index + 1).find((candidate) => {
        const value = candidate.trim();
        return value && !value.startsWith("--");
      })?.trim() || "";

      if (/^(from|where|group\s+by|having|qualify|order\s+by|limit|offset|union)\b/i.test(nextLine)) {
        issues.push({
          severity: "medium",
          title: "Dangling comma before clause",
          detail: `Line ${index + 1} ends with a comma immediately before ${nextLine.split(/\s+/).slice(0, 2).join(" ").toUpperCase()}.`,
          evidence: trimmed,
          suggestion: "Remove the comma or add the missing select expression before the next clause."
        });
      }
    }
  });

  return issues;
}

function lineWithKeyword(sql, keyword) {
  return String(sql || "").split(/\r?\n/).find((line) => new RegExp(`\\b${keyword}\\b`, "i").test(line))?.trim() || keyword.toUpperCase();
}

function inspectProjection(ast, schema, findings) {
  const sourceCount = ast.sources.length + ast.joins.length;
  const wildcardProjection = ast.projections.find((projection) => projection.wildcard);

  if (wildcardProjection) {
    findings.push(finding(
      "medium",
      "privacy",
      "Wildcard projection broadens the blast radius",
      "SELECT * can pull sensitive or newly added columns into downstream reports without a code change.",
      wildcardProjection.text,
      "List the required columns explicitly and keep sensitive fields out of default projections."
    ));
  }

  const sensitiveSelections = findSensitiveSelections(ast, schema);
  for (const entry of sensitiveSelections) {
    findings.push(finding(
      "high",
      "privacy",
      "Sensitive field reaches the result set",
      `${entry.column} is marked or inferred as sensitive and appears in the projection.`,
      entry.evidence,
      "Mask, hash, aggregate, or remove the field unless the recipient is authorized."
    ));
  }

  if (sourceCount > 1) {
    for (const projection of ast.projections) {
      const bareColumn = /\b[a-z_][\w$]*\b/i.test(projection.text)
        && projection.references.length === 0
        && !projection.aggregate
        && !projection.wildcard;
      if (bareColumn) {
        findings.push(finding(
          "medium",
          "correctness",
          "Projection may be ambiguous across joined sources",
          "An unqualified column in a multi-source query can bind differently after schema changes.",
          projection.text,
          "Qualify the column with its source alias."
        ));
      }
    }
  }

  if (ast.distinct && ast.joins.length > 0) {
    findings.push(finding(
      "low",
      "correctness",
      "DISTINCT may be hiding join duplication",
      "DISTINCT after joins often means the join cardinality is not fully understood.",
      "SELECT DISTINCT",
      "Check whether a join should be constrained, pre-aggregated, or rewritten as EXISTS."
    ));
  }
}

function inspectJoins(ast, schema, findings) {
  for (const join of ast.joins) {
    if (!join.condition && join.type !== "cross") {
      findings.push(finding(
        "high",
        "correctness",
        "Join has no predicate",
        `${join.source.displayName || join.source.name} joins without ON or USING, which can create a cartesian product.`,
        `${join.type.toUpperCase()} JOIN ${join.source.displayName || join.source.name}`,
        "Add a join predicate or make the cartesian intent explicit with CROSS JOIN and a row-count guard."
      ));
    }

    if (join.type === "cross") {
      findings.push(finding(
        "medium",
        "performance",
        "Cross join multiplies rows by design",
        "Cross joins are valid, but they are dangerous without tight upstream filters or small source tables.",
        `CROSS JOIN ${join.source.displayName || join.source.name}`,
        "Confirm expected cardinality and place the smallest bounded source on the cross side."
      ));
    }

    if (/=\s*[^=]/.test(join.condition) && !join.condition.includes(".")) {
      findings.push(finding(
        "medium",
        "correctness",
        "Join predicate is hard to trace",
        "The join condition lacks qualified column references, making lineage and ambiguity checks weaker.",
        join.condition,
        "Qualify both sides of the join with table aliases."
      ));
    }

    inspectJoinIndexes(ast, schema, join, findings);
  }

  for (const join of ast.joins.filter((entry) => entry.type === "left")) {
    const rightNames = new Set([join.source.alias, join.source.name].filter(Boolean));
    const nullRejecting = ast.predicates.find((predicate) => {
      const text = predicate.text.toLowerCase();
      const touchesRight = predicate.references.some((reference) => rightNames.has(reference.qualifier));
      return touchesRight && !/\bis\s+null\b/i.test(text);
    });

    if (nullRejecting) {
      findings.push(finding(
        "high",
        "correctness",
        "WHERE clause can erase LEFT JOIN preservation",
        "A predicate on the nullable side of a LEFT JOIN in WHERE can turn it into an inner join.",
        nullRejecting.text,
        "Move the predicate into the JOIN condition or make the null-preserving intent explicit."
      ));
    }
  }

  const countAll = ast.projections.some((projection) => /\bcount\s*\(\s*\*\s*\)/i.test(projection.text));
  if (countAll && ast.joins.length > 0) {
    findings.push(finding(
      "medium",
      "correctness",
      "COUNT(*) occurs after joins",
      "Counting after one-to-many joins can inflate entity counts.",
      "COUNT(*)",
      "Count a stable primary key, pre-aggregate the many side, or count distinct entities intentionally."
    ));
  }
}

function inspectPredicates(ast, schema, findings) {
  const predicates = [...ast.predicates, ...ast.having];

  for (const predicate of predicates) {
    const text = predicate.text;
    const lower = text.toLowerCase();

    if (/\bnot\s+in\s*\(/i.test(text)) {
      findings.push(finding(
        "high",
        "correctness",
        "NOT IN can fail in the presence of NULL",
        "If the subquery or list contains NULL, NOT IN can return no rows unexpectedly.",
        text,
        "Prefer NOT EXISTS with a correlated predicate or filter NULLs inside the subquery."
      ));
    }

    if (/(=|!=|<>)\s*null\b/i.test(text)) {
      findings.push(finding(
        "high",
        "correctness",
        "NULL compared with equality operator",
        "SQL three-valued logic requires IS NULL or IS NOT NULL for null checks.",
        text,
        "Use IS NULL or IS NOT NULL."
      ));
    }

    if (/\bor\b/i.test(text)) {
      findings.push(finding(
        "medium",
        "performance",
        "OR predicate may block selective access paths",
        "OR across columns or tables can prevent targeted index use and complicate selectivity estimates.",
        text,
        "Consider UNION ALL branches or separate indexed predicates when the alternatives are independent."
      ));
    }

    if (/\blike\s+'%/i.test(text) || /\bilike\s+'%/i.test(text)) {
      findings.push(finding(
        "medium",
        "performance",
        "Leading wildcard prevents normal index seeks",
        "Patterns that start with % usually force scans in common engines.",
        text,
        "Use full-text search, trigram indexes, search tables, or anchored patterns."
      ));
    }

    if (/\b(lower|upper|date|cast|coalesce|substring|substr|trim)\s*\(\s*[\w"`\[\].]+/i.test(text)) {
      findings.push(finding(
        "medium",
        "performance",
        "Function-wrapped column is likely non-sargable",
        "Wrapping a column in a function can stop the optimizer from using a normal index.",
        text,
        "Move transformations to constants, use persisted computed columns, or add a matching functional index."
      ));
    }

    if (containsLiteral(text)) {
      findings.push(finding(
        "info",
        "safety",
        "Predicate contains inline literal values",
        "Literals are useful during exploration, but production query paths should be parameterized.",
        text,
        "Use bind parameters for user-controlled values and keep sample constants out of committed analytics."
      ));
    }

    inspectPredicateIndexes(ast, schema, predicate, findings);

    if (lower.includes("between") && /timestamp|date/i.test(inferReferencedTypes(ast, schema, predicate).join(" "))) {
      findings.push(finding(
        "low",
        "correctness",
        "BETWEEN on date-time columns is inclusive",
        "Inclusive upper bounds often double-count midnight or miss fractional seconds assumptions.",
        text,
        "Use a half-open interval such as >= start AND < next_period."
      ));
    }
  }
}

function inspectGrouping(ast, findings) {
  if (ast.groupBy.length === 0) return;

  const groupRefs = new Set(ast.groupBy.flatMap((entry) => entry.references.map((reference) => reference.text.toLowerCase())));

  for (const projection of ast.projections) {
    if (projection.aggregate || projection.windowed || projection.wildcard) continue;
    const projectionRefs = projection.references.map((reference) => reference.text.toLowerCase());
    const ungrouped = projectionRefs.length > 0 && projectionRefs.some((reference) => !groupRefs.has(reference));
    const expressionOnly = projectionRefs.length === 0 && !ast.groupBy.some((entry) => entry.text.toLowerCase() === projection.text.toLowerCase());

    if (ungrouped || expressionOnly) {
      findings.push(finding(
        "high",
        "correctness",
        "Projection is not clearly grouped or aggregated",
        "Some SQL engines reject this, while permissive engines may return arbitrary values.",
        projection.text,
        "Add the expression to GROUP BY or wrap it in an aggregate with an intentional rule."
      ));
    }
  }
}

function inspectOrdering(ast, findings) {
  if (ast.limit && ast.orderBy.length === 0) {
    findings.push(finding(
      "low",
      "correctness",
      "LIMIT without ORDER BY is nondeterministic",
      "A bounded result without stable ordering can return different rows between runs.",
      `LIMIT ${ast.limit}`,
      "Add ORDER BY on a deterministic key before relying on the sample."
    ));
  }

  if (ast.offset) {
    findings.push(finding(
      "low",
      "performance",
      "OFFSET pagination grows slower with depth",
      "Large offsets make the database scan and discard rows before returning the page.",
      `OFFSET ${ast.offset}`,
      "Use keyset pagination with a stable sort key for deep navigation."
    ));
  }

  if (ast.orderBy.length > 0 && !ast.limit) {
    findings.push(finding(
      "low",
      "performance",
      "ORDER BY has no result bound",
      "Sorting an unbounded result can be expensive and memory-heavy.",
      ast.clauses.orderBy,
      "Add a LIMIT for exploratory queries or confirm the caller needs the complete ordered set."
    ));
  }
}

function inspectBooleanLogic(ast, findings) {
  const where = ast.clauses.where || "";
  if (!where) return;

  const mixedAndOr = /\band\b/i.test(where) && /\bor\b/i.test(where);
  const hasGrouping = /\([^)]*\b(and|or)\b[^)]*\)/i.test(where);

  if (mixedAndOr && !hasGrouping) {
    findings.push(finding(
      "high",
      "correctness",
      "WHERE mixes AND and OR without visible grouping",
      "SQL operator precedence can include more rows than intended when OR is not parenthesized.",
      where,
      "Add parentheses around each logical branch so the intended truth table is explicit."
    ));
  }
}

function inspectWindowing(ast, findings) {
  const sql = ast.sql || "";

  if (/\b(row_number|rank|dense_rank|ntile)\s*\([^)]*\)\s*over\s*\((?![^)]*\border\s+by\b)[^)]*\)/i.test(sql)) {
    findings.push(finding(
      "medium",
      "correctness",
      "Window ranking has no deterministic ORDER BY",
      "Ranking functions without ORDER BY can assign unstable ranks between executions.",
      "OVER (...)",
      "Add ORDER BY inside the window definition using a deterministic tie-breaker."
    ));
  }

  if (/\b(last_value|first_value)\s*\([^)]*\)\s*over\s*\([^)]*\border\s+by\b(?![^)]*\b(rows|range)\b)[^)]*\)/i.test(sql)) {
    findings.push(finding(
      "low",
      "correctness",
      "Window value function relies on the default frame",
      "FIRST_VALUE and LAST_VALUE often surprise reviewers unless ROWS or RANGE is explicit.",
      "FIRST_VALUE/LAST_VALUE",
      "Specify ROWS BETWEEN ... so the frame matches the business question."
    ));
  }
}

function inspectReviewFragility(ast, findings) {
  const commaFrom = /\bfrom\b(?:(?!\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b)[\s\S])*,(?:(?!\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b)[\s\S])*/i;
  if (commaFrom.test(ast.sql || "")) {
    findings.push(finding(
      "medium",
      "correctness",
      "Comma joins hide join intent",
      "Comma-separated FROM lists make cartesian behavior and join predicates harder to audit.",
      ast.clauses.from || "FROM ... , ...",
      "Use explicit JOIN syntax with ON predicates."
    ));
  }

  for (const group of ast.groupBy) {
    if (/^\d+$/.test(group.text.trim())) {
      findings.push(finding(
        "low",
        "maintainability",
        "GROUP BY ordinal is fragile",
        "Grouping by select-list position can silently change when projections are reordered.",
        `GROUP BY ${group.text}`,
        "Group by the named expression instead of its ordinal position."
      ));
    }
  }

  for (const order of ast.orderBy) {
    if (/^\d+(\s+(asc|desc))?$/i.test(order.text.trim())) {
      findings.push(finding(
        "low",
        "maintainability",
        "ORDER BY ordinal is fragile",
        "Ordering by select-list position makes reviews and future edits more error-prone.",
        `ORDER BY ${order.text}`,
        "Order by the output alias or explicit expression."
      ));
    }
  }

  if (/\bwith\s+recursive\b/i.test(ast.sql || "") && !ast.limit) {
    findings.push(finding(
      "medium",
      "performance",
      "Recursive CTE has no visible depth guard",
      "Recursive queries can expand unexpectedly if termination relies on data quality alone.",
      "WITH RECURSIVE",
      "Add an explicit depth counter, max level predicate, or runtime guard."
    ));
  }
}

function inspectSchemaCoverage(ast, schema, findings) {
  if (schema.tables.size === 0) {
    findings.push(finding(
      "info",
      "schema",
      "Schema notes would sharpen this atlas",
      "Without DDL or row counts, index, sensitivity, and blast-radius checks fall back to conservative assumptions.",
      "",
      "Paste CREATE TABLE statements, CREATE INDEX statements, and optional rows: table=100000 notes."
    ));
    return;
  }

  const missing = [...ast.sources, ...ast.joins.map((join) => join.source)]
    .filter((source) => source.type === "table" && !lookupTable(schema, source.name));

  for (const source of missing) {
    findings.push(finding(
      "low",
      "schema",
      "Source has no schema note",
      `${source.displayName || source.name} appears in SQL but not in the schema notes.`,
      source.displayName || source.name,
      "Add its CREATE TABLE block to enable column and index checks."
    ));
  }
}

function inspectCtes(ast, findings) {
  for (const cte of ast.ctes) {
    const cteStatement = cte.statement;
    if (cteStatement?.projections?.some((projection) => projection.wildcard)) {
      findings.push(finding(
        "low",
        "maintainability",
        "CTE exports wildcard columns",
        `${cte.displayName} uses SELECT *, which makes downstream dependencies opaque.`,
        cte.sql,
        "Name the CTE columns that downstream clauses need."
      ));
    }

    if (cteStatement?.joins?.length > 2 && cteStatement.predicates.length === 0) {
      findings.push(finding(
        "medium",
        "performance",
        "CTE joins several sources before filtering",
        `${cte.displayName} may materialize or expand a large intermediate set depending on the engine.`,
        cte.sql,
        "Push selective filters into the CTE or pre-aggregate high-cardinality joins."
      ));
    }
  }
}

function inspectJoinIndexes(ast, schema, join, findings) {
  if (schema.tables.size === 0 || join.references.length === 0) return;

  for (const reference of join.references) {
    const tableName = resolveAlias(ast, reference.qualifier);
    const table = lookupTable(schema, tableName);
    const column = lookupColumn(table, reference.column);
    if (!table || !column) continue;
    if (isIndexed(table, column.name)) continue;

    findings.push(finding(
      "medium",
      "performance",
      "Join column is not indexed in schema notes",
      `${table.displayName}.${column.displayName} participates in a join but no matching index is listed.`,
      join.condition,
      "Add or confirm an index on the join key, especially on the many side."
    ));
  }
}

function inspectPredicateIndexes(ast, schema, predicate, findings) {
  if (schema.tables.size === 0 || predicate.references.length === 0) return;

  for (const reference of predicate.references) {
    const tableName = resolveAlias(ast, reference.qualifier);
    const table = lookupTable(schema, tableName);
    const column = lookupColumn(table, reference.column);
    if (!table || !column) continue;
    if (isIndexed(table, column.name) || isLowSelectivity(column)) continue;

    findings.push(finding(
      "low",
      "performance",
      "Filtered column lacks an index note",
      `${table.displayName}.${column.displayName} appears in a predicate without a listed index.`,
      predicate.text,
      "Confirm the filter is selective or add an index that matches the predicate shape."
    ));
  }
}

function findSensitiveSelections(ast, schema) {
  const entries = [];

  for (const projection of ast.projections) {
    if (projection.wildcard) {
      for (const stat of sourceStats(ast, schema)) {
        for (const column of stat.table?.columns.values() ?? []) {
          if (column.sensitive) {
            entries.push({ column: `${stat.table.displayName}.${column.displayName}`, evidence: projection.text });
          }
        }
      }
      continue;
    }

    for (const reference of projection.references) {
      const tableName = resolveAlias(ast, reference.qualifier);
      const table = lookupTable(schema, tableName);
      const column = lookupColumn(table, reference.column);
      if (column?.sensitive) {
        entries.push({ column: `${table.displayName}.${column.displayName}`, evidence: projection.text });
        continue;
      }

      const cteColumn = lookupSensitiveCteColumn(ast, schema, tableName, reference.column);
      if (cteColumn) {
        entries.push({ column: cteColumn, evidence: projection.text });
      }
    }
  }

  return entries;
}

function lookupSensitiveCteColumn(ast, schema, cteName, columnName) {
  const cte = ast.ctes.find((entry) => entry.name === cteName);
  if (!cte?.statement) return null;

  for (const projection of cte.statement.projections) {
    const projectedName = projection.alias || projection.references.at(-1)?.column || projection.text.toLowerCase();

    if (projection.wildcard) {
      const match = sensitiveColumnFromSources(cte.statement, schema, columnName);
      if (match) return `${cte.displayName}.${columnName} via ${match}`;
    }

    if (projectedName === columnName) {
      for (const reference of projection.references) {
        const sourceName = resolveAlias(cte.statement, reference.qualifier);
        const sourceTable = lookupTable(schema, sourceName);
        const sourceColumn = lookupColumn(sourceTable, reference.column);
        if (sourceColumn?.sensitive) {
          return `${cte.displayName}.${columnName} via ${sourceTable.displayName}.${sourceColumn.displayName}`;
        }
      }
    }
  }

  return null;
}

function sensitiveColumnFromSources(statement, schema, columnName) {
  const stats = sourceStats(statement, schema);
  for (const stat of stats) {
    const column = lookupColumn(stat.table, columnName);
    if (column?.sensitive) {
      return `${stat.table.displayName}.${column.displayName}`;
    }
  }
  return null;
}

function inferReferencedTypes(ast, schema, predicate) {
  return predicate.references.map((reference) => {
    const tableName = resolveAlias(ast, reference.qualifier);
    const table = lookupTable(schema, tableName);
    const column = lookupColumn(table, reference.column);
    return column?.type ?? "";
  });
}

function isIndexed(table, columnName) {
  return table.primaryKey.includes(columnName)
    || table.indexes.some((index) => index.columns[0] === columnName)
    || table.foreignKeys.some((key) => key.column === columnName);
}

function isLowSelectivity(column) {
  return /bool|boolean|flag|status|type|state/i.test(`${column.name} ${column.type}`);
}

function containsLiteral(text) {
  const tokens = tokenize(text);
  return tokens.some((token) => token.type === "string" || token.type === "number");
}

function summarize(findings) {
  const score = Math.min(100, findings.reduce((total, entry) => total + SEVERITY_WEIGHT[entry.severity], 0));
  const severityCounts = findings.reduce((counts, entry) => {
    counts[entry.severity] = (counts[entry.severity] ?? 0) + 1;
    return counts;
  }, {});

  const identity = attachStableIdentity(
    findings.map((finding) => ({
      id: finding.id,
      kind: "finding",
      signature: findingIdentitySignature(finding),
      target: finding
    })),
    {
      namespace: IDENTITY_NAMESPACE,
      schemaVersion: IDENTITY_SCHEMA_VERSION
    }
  );

  return {
    findings,
    score,
    severityCounts,
    riskLevel: score >= 60 ? "high" : score >= 28 ? "medium" : score >= 8 ? "low" : "info",
    identity
  };
}

function findingIdentitySignature(finding) {
  return {
    kind: "finding",
    category: finding.category,
    severity: finding.severity,
    title: finding.title.toLowerCase().trim(),
    evidence: canonicalClauseText(finding.evidence || ""),
    detail: canonicalClauseText(finding.detail || ""),
    suggestion: canonicalClauseText(finding.suggestion || "")
  };
}

function finding(severity, category, title, detail, evidence, suggestion) {
  return {
    id: `${category}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    severity,
    category,
    title,
    detail,
    evidence,
    suggestion
  };
}
