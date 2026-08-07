const DIALECTS = [
  {
    id: "postgres",
    label: "PostgreSQL",
    patterns: [
      [/::\s*[a-z_][\w$]*/i, "double-colon casts"],
      [/\bdistinct\s+on\s*\(/i, "DISTINCT ON"],
      [/\bilike\b/i, "ILIKE"],
      [/->>|#>>|jsonb?/i, "JSON operators"],
      [/\bserial\b|\bbigserial\b/i, "serial types"]
    ]
  },
  {
    id: "bigquery",
    label: "BigQuery",
    patterns: [
      [/`[^`]+\.[^`]+\.[^`]+`/, "project.dataset.table identifiers"],
      [/\bunnest\s*\(/i, "UNNEST"],
      [/\bqualify\b/i, "QUALIFY"],
      [/\bsafe_(cast|offset|ordinal)\s*\(/i, "SAFE functions"],
      [/\bselect\s+\*\s+except\s*\(/i, "SELECT * EXCEPT"],
      [/_partition(time|date)|_table_suffix/i, "partition or wildcard pseudo columns"]
    ]
  },
  {
    id: "snowflake",
    label: "Snowflake",
    patterns: [
      [/\bqualify\b/i, "QUALIFY"],
      [/\blateral\s+flatten\b|\bflatten\s*\(/i, "FLATTEN"],
      [/\bvariant\b/i, "VARIANT"],
      [/\biff\s*\(/i, "IFF"],
      [/\bzeroifnull\s*\(/i, "ZEROIFNULL"],
      [/\bsample\s*\(/i, "SAMPLE"]
    ]
  },
  {
    id: "databricks",
    label: "Databricks / Spark SQL",
    patterns: [
      [/\blateral\s+view\s+(outer\s+)?explode\b|\bposexplode\s*\(/i, "LATERAL VIEW EXPLODE"],
      [/\busing\s+delta\b|\bdelta\.`/i, "Delta tables"],
      [/\b(cluster|distribute|sort)\s+by\b/i, "Spark distribution clauses"],
      [/\bfrom_json\s*\(|\bschema_of_json\s*\(/i, "Spark JSON functions"],
      [/\bcollect_(list|set)\s*\(/i, "collection aggregates"]
    ]
  },
  {
    id: "trino",
    label: "Trino / Presto",
    patterns: [
      [/\bcross\s+join\s+unnest\b/i, "CROSS JOIN UNNEST"],
      [/\bwith\s+ordinality\b/i, "WITH ORDINALITY"],
      [/\bapprox_(distinct|percentile|set)\s*\(/i, "approximate aggregates"],
      [/\bdate_parse\s*\(|\bfrom_iso8601_/i, "Trino date functions"],
      [/\btry_cast\s*\(/i, "TRY_CAST"]
    ]
  },
  {
    id: "duckdb",
    label: "DuckDB",
    patterns: [
      [/\bread_(parquet|csv|csv_auto|json|json_auto)\s*\(/i, "file table functions"],
      [/\bselect\s+\*\s+(exclude|replace)\b/i, "SELECT * EXCLUDE/REPLACE"],
      [/\bgroup\s+by\s+all\b/i, "GROUP BY ALL"],
      [/\bstruct_pack\s*\(|\blist_transform\s*\(/i, "DuckDB nested functions"],
      [/\bpivot\b[\s\S]*\bon\b/i, "DuckDB PIVOT"]
    ]
  },
  {
    id: "redshift",
    label: "Amazon Redshift",
    patterns: [
      [/\b(distkey|sortkey|diststyle)\b/i, "distribution or sort keys"],
      [/\bapproximate\s+count\s*\(\s*distinct/i, "APPROXIMATE COUNT DISTINCT"],
      [/\bconvert_timezone\s*\(/i, "CONVERT_TIMEZONE"],
      [/\bdate_cmp_\w+\s*\(/i, "Redshift date comparison functions"],
      [/\bqualify\b/i, "QUALIFY"]
    ]
  },
  {
    id: "clickhouse",
    label: "ClickHouse",
    patterns: [
      [/\barray\s+join\b/i, "ARRAY JOIN"],
      [/\bprewhere\b/i, "PREWHERE"],
      [/\bglobal\s+(any\s+|all\s+)?join\b/i, "GLOBAL JOIN"],
      [/\barg(max|min)\s*\(/i, "argMax/argMin"],
      [/\btoDateTime\w*\s*\(/, "ClickHouse date functions"],
      [/\bfrom\s+[\w.`]+\s+final\b/i, "FINAL"]
    ]
  },
  {
    id: "sqlserver",
    label: "SQL Server",
    patterns: [
      [/\btop\s*\(?\s*\d+/i, "TOP"],
      [/\bwith\s*\(\s*nolock\s*\)/i, "NOLOCK"],
      [/\bdate(add|diff|part)\s*\(/i, "DATEADD family"],
      [/\bisnull\s*\(/i, "ISNULL"],
      [/\[[^\]]+\]/, "bracket identifiers"],
      [/(^|[^@])@\w+|#\w+/i, "T-SQL variables or temp tables"]
    ]
  },
  {
    id: "mysql",
    label: "MySQL",
    patterns: [
      [/`[^`]+`/, "backtick identifiers"],
      [/\blimit\s+\d+\s*,\s*\d+/i, "LIMIT offset,count"],
      [/\bsql_calc_found_rows\b/i, "SQL_CALC_FOUND_ROWS"],
      [/\b(force|use|ignore)\s+index\b/i, "index hints"],
      [/\bifnull\s*\(/i, "IFNULL"],
      [/\bdate_format\s*\(/i, "DATE_FORMAT"]
    ]
  },
  {
    id: "oracle",
    label: "Oracle",
    patterns: [
      [/\(\+\)/, "legacy outer join"],
      [/\brownum\b/i, "ROWNUM"],
      [/\bnvl\s*\(/i, "NVL"],
      [/\bconnect\s+by\b/i, "CONNECT BY"],
      [/\bminus\b/i, "MINUS"],
      [/\bfrom\s+dual\b/i, "DUAL"]
    ]
  },
  {
    id: "sqlite",
    label: "SQLite",
    patterns: [
      [/\bpragma\b/i, "PRAGMA"],
      [/\browid\b/i, "ROWID"],
      [/\bstrftime\s*\(/i, "strftime"],
      [/\bdatetime\s*\(/i, "datetime"],
      [/\bglob\b/i, "GLOB"]
    ]
  }
];

const LABEL_BY_ID = new Map(DIALECTS.map((dialect) => [dialect.id, dialect.label]));

export function detectDialect(sql) {
  const text = String(sql || "");
  const scored = DIALECTS.map((dialect) => {
    const signals = dialect.patterns
      .filter(([pattern]) => pattern.test(text))
      .map(([, label]) => label);
    return {
      id: dialect.id,
      label: dialect.label,
      score: signals.length,
      signals
    };
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  const primary = scored[0]?.score > 0 ? scored[0] : { id: "ansi", label: "ANSI-ish", score: 0, signals: [] };
  const runnerUp = scored.find((entry) => entry.id !== primary.id && entry.score > 0);
  const signalCount = scored.reduce((total, entry) => total + entry.score, 0);
  const confidence = signalCount === 0
    ? "low"
    : primary.score >= 3 && (!runnerUp || primary.score >= runnerUp.score + 2)
      ? "high"
      : primary.score >= 2
        ? "medium"
        : "low";

  return {
    primary: primary.id,
    label: primary.label,
    confidence,
    signals: primary.signals,
    alternatives: scored.filter((entry) => entry.score > 0 && entry.id !== primary.id).slice(0, 3),
    scores: scored.filter((entry) => entry.score > 0)
  };
}

export function dialectFindings(ast, dialect) {
  const sql = ast.sql || "";
  const findings = [];

  inspectPortability(sql, dialect, findings);
  inspectDialectSpecifics(sql, ast, dialect, findings);

  return findings;
}

export function dialectLabel(id) {
  return LABEL_BY_ID.get(id) || (id === "ansi" ? "ANSI-ish" : String(id || "Unknown"));
}

function inspectPortability(sql, dialect, findings) {
  if (dialect.alternatives.length > 0 && dialect.confidence !== "high") {
    findings.push(finding(
      "low",
      "dialect",
      "Dialect signals are mixed",
      `${dialect.label} appears likely, but the query also contains ${dialect.alternatives.map((entry) => entry.label).join(", ")} signals.`,
      dialect.alternatives.flatMap((entry) => entry.signals).slice(0, 3).join(", "),
      "Confirm the target engine before trusting portability or syntax-specific rewrite advice."
    ));
  }

  if (/\bqualify\b/i.test(sql) && !["bigquery", "snowflake"].includes(dialect.primary)) {
    findings.push(finding(
      "medium",
      "dialect",
      "QUALIFY is not portable across common engines",
      "QUALIFY is supported in engines such as BigQuery and Snowflake, but many engines require a subquery filter over window output.",
      "QUALIFY",
      "For portable SQL, wrap the windowed SELECT and filter the computed column in an outer WHERE."
    ));
  }

  if (/\bminus\b/i.test(sql) && dialect.primary !== "oracle") {
    findings.push(finding(
      "low",
      "dialect",
      "MINUS may need EXCEPT outside Oracle-style SQL",
      "Set-difference keywords vary by engine, which can break copied review snippets.",
      "MINUS",
      "Use the target engine's set-difference operator and test duplicate handling."
    ));
  }
}

function inspectDialectSpecifics(sql, ast, dialect, findings) {
  inspectGeneric(sql, ast, findings);
  inspectBigQuery(sql, ast, dialect, findings);
  inspectSnowflake(sql, findings);
  inspectDatabricks(sql, dialect, findings);
  inspectTrino(sql, dialect, findings);
  inspectDuckDb(sql, dialect, findings);
  inspectRedshift(sql, dialect, findings);
  inspectClickHouse(sql, dialect, findings);
  inspectSqlServer(sql, ast, dialect, findings);
  inspectPostgres(sql, ast, dialect, findings);
  inspectMySql(sql, dialect, findings);
  inspectOracle(sql, ast, dialect, findings);
  inspectSqlite(sql, dialect, findings);
}

function inspectGeneric(sql, ast, findings) {
  if (/\{[{%][\s\S]*?[}%]\}/.test(sql)) {
    findings.push(finding(
      "medium",
      "lineage",
      "Templated SQL needs compiled context",
      "Jinja or dbt-style template blocks can hide relations, predicates, and branches from static SQL lineage.",
      "{{ ... }} / {% ... %}",
      "Analyze the compiled SQL for release review, then use the template source only to trace ownership."
    ));
  }

  if (/\bnatural\s+(left\s+|right\s+|full\s+|inner\s+)?join\b/i.test(sql)) {
    findings.push(finding(
      "high",
      "correctness",
      "NATURAL JOIN binds hidden column names",
      "A schema change can silently alter join keys because NATURAL JOIN derives equality columns by name.",
      "NATURAL JOIN",
      "Replace NATURAL JOIN with explicit ON predicates."
    ));
  }

  if (/\bunion\b(?!\s+all\b)/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "UNION performs duplicate elimination",
      "UNION usually sorts or hashes the combined result. That can hide duplication and add cost.",
      "UNION",
      "Use UNION ALL when duplicates are acceptable or already impossible."
    ));
  }

  if (/\bselect\s+\*\s+except\s*\(/i.test(sql) && ast.projections.some((projection) => projection.wildcard)) {
    findings.push(finding(
      "low",
      "privacy",
      "SELECT * EXCEPT still has a moving result contract",
      "Excluding a few fields does not prevent newly added columns from reaching downstream consumers.",
      "SELECT * EXCEPT",
      "For governed outputs, name the full projection contract explicitly."
    ));
  }
}

function inspectBigQuery(sql, ast, dialect, findings) {
  if (dialect.primary !== "bigquery" && !/`[^`]+\.[^`]+\.[^`]+`/.test(sql)) return;

  if (/\bfrom\s+`[^`]*\*[^`]*`/i.test(sql) && !/_table_suffix/i.test(sql)) {
    findings.push(finding(
      "high",
      "performance",
      "BigQuery wildcard table lacks _TABLE_SUFFIX pruning",
      "Wildcard table scans can fan out across many physical tables when no suffix filter is visible.",
      "FROM `...*`",
      "Add a selective _TABLE_SUFFIX predicate or query an explicit table list."
    ));
  }

  if (/\b(cross\s+join\s+)?unnest\s*\(/i.test(sql)) {
    findings.push(finding(
      "medium",
      "performance",
      "UNNEST can multiply rows",
      "Array expansion changes grain and can inflate measures unless the intended entity level is preserved.",
      "UNNEST",
      "Document the output grain and aggregate arrays before joining when possible."
    ));
  }

  if (ast.sources.length > 0 && !/_partition(time|date)\b/i.test(sql) && /created_at|event_date|timestamp/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "No visible BigQuery partition filter",
      "Large BigQuery fact tables usually need partition pruning for predictable cost.",
      "created_at/event_date",
      "If the table is partitioned, filter on the partitioning column or pseudo column."
    ));
  }
}

function inspectSnowflake(sql, findings) {
  if (/\blateral\s+flatten\b|\bflatten\s*\(/i.test(sql)) {
    findings.push(finding(
      "medium",
      "performance",
      "FLATTEN changes the row grain",
      "Snowflake FLATTEN expands semi-structured values and can duplicate parent rows.",
      "FLATTEN",
      "Carry the parent key and validate row counts before and after flattening."
    ));
  }

  if (/\bsample\s*\(/i.test(sql)) {
    findings.push(finding(
      "low",
      "correctness",
      "SAMPLE makes results non-repeatable",
      "Sampling is useful for exploration but can surprise dashboards, tests, and reconciliation work.",
      "SAMPLE",
      "Use deterministic filters or persist sampled cohorts when repeatability matters."
    ));
  }
}

function inspectDatabricks(sql, dialect, findings) {
  if (dialect.primary !== "databricks" && !/\blateral\s+view\s+(outer\s+)?explode\b/i.test(sql)) return;

  if (/\blateral\s+view\s+(outer\s+)?explode\b|\bposexplode\s*\(/i.test(sql)) {
    findings.push(finding(
      "medium",
      "correctness",
      "EXPLODE changes the model grain",
      "Spark array expansion emits one row per element and can multiply measures from the parent record.",
      "LATERAL VIEW EXPLODE",
      "Carry the parent key, state the post-explode grain, and aggregate before joining to other many-side relations."
    ));
  }

  if (/\bcollect_(list|set)\s*\(/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "Collection aggregate can create unbounded rows",
      "Large collect_list or collect_set groups can build very large in-memory arrays and stress executors.",
      "collect_list / collect_set",
      "Bound group cardinality, keep only required fields, or materialize a child relation instead of an array."
    ));
  }
}

function inspectTrino(sql, dialect, findings) {
  if (dialect.primary !== "trino" && !/\bcross\s+join\s+unnest\b/i.test(sql)) return;

  if (/\bcross\s+join\s+unnest\b/i.test(sql)) {
    findings.push(finding(
      "medium",
      "correctness",
      "CROSS JOIN UNNEST multiplies parent rows",
      "Trino emits one output row per array element, changing grain before downstream joins and aggregates.",
      "CROSS JOIN UNNEST",
      "Retain the parent key and validate the row count before and after UNNEST."
    ));
  }

  if (/\bapprox_(distinct|percentile|set)\s*\(/i.test(sql)) {
    findings.push(finding(
      "low",
      "contract",
      "Approximate aggregate needs an accuracy contract",
      "Approximate Trino aggregates trade exactness for speed, which can surprise reconciliations and KPI consumers.",
      "approx_*",
      "Document the expected error bound and keep exact reconciliation paths for governed metrics."
    ));
  }
}

function inspectDuckDb(sql, dialect, findings) {
  if (dialect.primary !== "duckdb") return;

  if (/\bread_(parquet|csv|csv_auto|json|json_auto)\s*\(/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "External file scan needs pruning evidence",
      "File table functions can scan broad globs or remote objects when partition and filename predicates are not visible.",
      "read_parquet / read_csv / read_json",
      "Constrain file paths, project required columns, and verify predicate pushdown with EXPLAIN."
    ));
  }

  if (/\bgroup\s+by\s+all\b/i.test(sql)) {
    findings.push(finding(
      "low",
      "contract",
      "GROUP BY ALL couples grain to the SELECT list",
      "Adding a non-aggregate projection silently changes grouping keys and therefore the output grain.",
      "GROUP BY ALL",
      "Name governed grouping keys explicitly before publishing the model."
    ));
  }
}

function inspectRedshift(sql, dialect, findings) {
  if (dialect.primary !== "redshift") return;

  if (/\bapproximate\s+count\s*\(\s*distinct/i.test(sql)) {
    findings.push(finding(
      "low",
      "contract",
      "Approximate count needs an accuracy contract",
      "Redshift approximate distinct counts can differ from exact reconciliations and finance controls.",
      "APPROXIMATE COUNT(DISTINCT)",
      "Document acceptable error and retain an exact validation query for governed reporting."
    ));
  }

  if (/\bdiststyle\s+all\b/i.test(sql)) {
    findings.push(finding(
      "medium",
      "performance",
      "DISTSTYLE ALL replicates the relation",
      "Redshift stores a full copy on every compute node, which can make large or frequently updated tables expensive.",
      "DISTSTYLE ALL",
      "Reserve ALL distribution for small, slow-changing dimensions and verify table size."
    ));
  }
}

function inspectClickHouse(sql, dialect, findings) {
  if (dialect.primary !== "clickhouse") return;

  if (/\bfrom\s+[\w.`]+\s+final\b/i.test(sql)) {
    findings.push(finding(
      "medium",
      "performance",
      "FINAL can force expensive merge work",
      "ClickHouse FINAL resolves collapsed or replacing rows at read time and can sharply increase latency on large partitions.",
      "FINAL",
      "Use partition filters, validate engine settings, and prefer data that is already merged for recurring workloads."
    ));
  }

  if (/\barray\s+join\b/i.test(sql)) {
    findings.push(finding(
      "medium",
      "correctness",
      "ARRAY JOIN changes the model grain",
      "Each array element becomes a row, which can multiply parent-level measures and alter join cardinality.",
      "ARRAY JOIN",
      "Carry the parent key and aggregate at the intended grain before combining measures."
    ));
  }
}

function inspectSqlServer(sql, ast, dialect, findings) {
  if (dialect.primary !== "sqlserver" && !/\bwith\s*\(\s*nolock\s*\)/i.test(sql)) return;

  if (/\bwith\s*\(\s*nolock\s*\)/i.test(sql)) {
    findings.push(finding(
      "high",
      "correctness",
      "NOLOCK can read uncommitted or duplicated rows",
      "SQL Server NOLOCK trades consistency for concurrency and can return dirty, missing, or duplicated rows.",
      "WITH (NOLOCK)",
      "Use snapshot isolation or document why dirty reads are acceptable."
    ));
  }

  if (/\btop\s*\(?\s*\d+/i.test(sql) && ast.orderBy.length === 0) {
    findings.push(finding(
      "medium",
      "correctness",
      "TOP without ORDER BY is nondeterministic",
      "SQL Server can return any qualifying rows when TOP has no stable ordering.",
      "TOP",
      "Add ORDER BY on a deterministic key."
    ));
  }
}

function inspectPostgres(sql, ast, dialect, findings) {
  if (dialect.primary !== "postgres" && !/\bdistinct\s+on\s*\(/i.test(sql)) return;

  if (/\bdistinct\s+on\s*\(/i.test(sql) && ast.orderBy.length === 0) {
    findings.push(finding(
      "medium",
      "correctness",
      "DISTINCT ON needs deterministic ordering",
      "PostgreSQL DISTINCT ON keeps the first row per group, so missing ORDER BY makes the chosen row unstable.",
      "DISTINCT ON",
      "Add ORDER BY beginning with the DISTINCT ON expressions plus a tie-breaker."
    ));
  }

  if (/[a-z_][\w$."]*::\s*(date|timestamp|text)\b/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "PostgreSQL cast may hide an indexable column",
      "Casting a column in a predicate can prevent normal b-tree index use unless an expression index exists.",
      "::date/::timestamp/::text",
      "Move casts to constants or add a matching expression index."
    ));
  }
}

function inspectMySql(sql, dialect, findings) {
  if (dialect.primary !== "mysql" && !/\bsql_calc_found_rows\b/i.test(sql)) return;

  if (/\bsql_calc_found_rows\b/i.test(sql)) {
    findings.push(finding(
      "medium",
      "performance",
      "SQL_CALC_FOUND_ROWS is a MySQL performance trap",
      "This pattern is deprecated in MySQL and can force extra work for pagination counts.",
      "SQL_CALC_FOUND_ROWS",
      "Run a separate count query or use an approximate count strategy."
    ));
  }

  if (/\blimit\s+\d+\s*,\s*\d+/i.test(sql)) {
    findings.push(finding(
      "low",
      "performance",
      "MySQL LIMIT offset,count can become deep-offset pagination",
      "The first number is rows to skip, which grows slower as pages get deeper.",
      "LIMIT offset,count",
      "Prefer keyset pagination with the last-seen ordered key."
    ));
  }
}

function inspectOracle(sql, ast, dialect, findings) {
  if (dialect.primary !== "oracle" && !/\(\+\)/.test(sql)) return;

  if (/\(\+\)/.test(sql)) {
    findings.push(finding(
      "high",
      "correctness",
      "Legacy Oracle outer join syntax is fragile",
      "The (+) syntax is easy to misplace and makes mixed outer/inner join intent hard to review.",
      "(+)",
      "Rewrite with explicit LEFT JOIN or RIGHT JOIN clauses."
    ));
  }

  if (/\brownum\b/i.test(sql) && ast.orderBy.length > 0) {
    findings.push(finding(
      "medium",
      "correctness",
      "ROWNUM can apply before ORDER BY",
      "Classic Oracle ROWNUM filters may happen before sorting unless the sort is isolated in a subquery.",
      "ROWNUM",
      "Use FETCH FIRST or wrap ORDER BY in an inner query before applying ROWNUM."
    ));
  }
}

function inspectSqlite(sql, dialect, findings) {
  if (dialect.primary !== "sqlite") return;

  if (/\blike\b/i.test(sql)) {
    findings.push(finding(
      "low",
      "dialect",
      "SQLite LIKE case behavior can surprise portability",
      "SQLite LIKE is commonly case-insensitive for ASCII unless configured otherwise.",
      "LIKE",
      "Use explicit collations or normalized search columns for portable matching."
    ));
  }
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
