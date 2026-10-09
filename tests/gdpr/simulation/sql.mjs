// Writes the SQL of the database checks of the GDPR simulation (MAIR-497) into <run dir>/db/:
// erasure.sql, retention.sql, content.sql. The repo's script runs each with
// `psql -At -f <file> > <file>.json` on the stack's database, after the purge.
//
// Usage: node simulation/sql.mjs <inventory.yaml> <schema.json> <run dir>
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseInventory } from "../inventory.mjs";
import { contentSampleSql, DEFAULT_RETENTION_COLUMNS, erasureSql, retentionSql } from "./db.mjs";

export function main([inventoryFile, schemaFile, runDir]) {
  if (!inventoryFile || !schemaFile || !runDir) {
    console.error("usage: node simulation/sql.mjs <inventory.yaml> <schema.json> <run dir>");
    return 2;
  }
  const { errors, entries } = parseInventory(readFileSync(inventoryFile, "utf8"));
  if (errors.length > 0) {
    console.error(`${inventoryFile} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  const { personas } = JSON.parse(readFileSync(join(runDir, "personas.json"), "utf8"));
  let columns = DEFAULT_RETENTION_COLUMNS;
  try {
    columns = JSON.parse(readFileSync(join(runDir, "retention_columns.json"), "utf8")) ?? DEFAULT_RETENTION_COLUMNS;
  } catch {
    // the defaults
  }
  mkdirSync(join(runDir, "db"), { recursive: true });
  writeFileSync(join(runDir, "db", "erasure.sql"), `${erasureSql(entries, schema, personas)}\n`);
  writeFileSync(join(runDir, "db", "retention.sql"), `${retentionSql(columns)}\n`);
  writeFileSync(join(runDir, "db", "content.sql"), `${contentSampleSql(entries, schema)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
