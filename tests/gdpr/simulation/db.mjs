// Database side of the GDPR simulation (MAIR-497): SQL the runner executes with psql at the end of
// the run (`psql -At -f <file>`, each query prints one JSON document), built from the inventory
// and the migrated schema (tests/gdpr/schema.sql).
const TEXTUAL = /^(text|character varying.*|character.*|citext|jsonb?|.*\[\])$/;
const ident = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const DEFAULT_RETENTION_COLUMNS = {
  sessions: "created_at",
  connection_logs: "timestamp",
  access_logs: "timestamp",
  users_audit_log: "action_date",
};

const personalTextColumns = (entries, schema, predicate) =>
  schema.filter((c) => TEXTUAL.test(c.type) && predicate(entries.get(`${c.table_name}.${c.column_name}`)));

// Values of the erased personas still found outside the columns the inventory keeps:
// [{ table_name, column_name, persona, field, rows }].
export function erasureSql(entries, schema, personas) {
  const erased = personas.filter((p) => p.erase);
  const columns = personalTextColumns(entries, schema, (e) => e?.personal && e.erasure !== "keep" && e.category !== "credentials");
  const probes = [];
  for (const c of columns) {
    for (const p of erased) {
      for (const [field, value] of Object.entries(p.values)) {
        if (field === "password") continue; // stored as a hash: never equal to the value
        const needle = field === "phone" ? value.replace(/^0/, "") : value;
        probes.push(`SELECT ${literal(c.table_name)} AS table_name, ${literal(c.column_name)} AS column_name, ${literal(p.id)} AS persona, ${literal(field)} AS field, count(*) AS rows FROM ${ident(c.table_name)} WHERE ${ident(c.column_name)}::text ILIKE ${literal(`%${needle}%`)}`);
      }
    }
  }
  if (probes.length === 0) return "SELECT '[]';";
  return `SELECT coalesce(json_agg(t), '[]') FROM (\n${probes.join("\nUNION ALL\n")}\n) t WHERE t.rows > 0;`;
}

// Rows older than the retention period of their table: [{ table_name, rows, retention }].
export function retentionSql(columns = DEFAULT_RETENTION_COLUMNS) {
  const probes = Object.entries(columns).map(([table, column]) =>
    `SELECT ${literal(table)} AS table_name, (SELECT count(*) FROM ${ident(table)} x WHERE x.${ident(column)} < now() - p.retention_period) AS rows, p.retention_period::text AS retention FROM retention_policies p WHERE p.table_name = ${literal(table)}`);
  return `SELECT coalesce(json_agg(t), '[]') FROM (\n${probes.join("\nUNION ALL\n")}\n) t WHERE t.rows > 0;`;
}

// A sample of the free-text and JSON columns (category `content`, or JSON types), for the AI
// review: [{ table_name, column_name, value }], `limit` distinct values per column.
export function contentSampleSql(entries, schema, limit = 20) {
  const columns = schema.filter((c) => {
    const e = entries.get(`${c.table_name}.${c.column_name}`);
    return e?.personal && (e.category === "content" || /^jsonb?$/.test(c.type));
  });
  if (columns.length === 0) return "SELECT '[]';";
  const probes = columns.map((c) =>
    `(SELECT ${literal(c.table_name)} AS table_name, ${literal(c.column_name)} AS column_name, v AS value FROM (SELECT DISTINCT left(${ident(c.column_name)}::text, 2000) AS v FROM ${ident(c.table_name)} WHERE ${ident(c.column_name)} IS NOT NULL LIMIT ${Number(limit)}) s)`);
  return `SELECT coalesce(json_agg(t), '[]') FROM (\n${probes.join("\nUNION ALL\n")}\n) t;`;
}
