// GDPR inventory gate (MAIR-285), run by the `gdpr_inventory` job of database_cicd.yml after
// release-staging, so that the Prod approver reads its summary before approving.
//
// Usage: node check.mjs <inventory.yaml> <schema.json> <report dir> [<previous inventory.yaml> <previous ref>]
//
// Exit 0: every column of the schema is classified. Exit 1: a gap (unclassified column, stale
// entry, reference to users not classified as an identifier). Exit 2: invalid inventory or input.
// The AI proposals never change the exit code.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { aiSettings, propose, proposalsYaml } from "./ai.mjs";
import { compare, describeEntry, diff, parseInventory } from "./inventory.mjs";

const code = (text) => `\`${text}\``;

export function summary({ inventory, schema, gaps, changes, previousRef, ai, label }) {
  const personal = [...inventory.values()].filter((e) => e.personal).length;
  const tables = new Set(schema.map((c) => c.table_name)).size;
  const blocked = gaps.missing.length + gaps.stale.length + gaps.notIdentifier.length > 0;
  const lines = ["## GDPR inventory", ""];
  lines.push(`Schema${label ? ` of ${code(label)}` : ""}: ${schema.length} columns in ${tables} tables; inventory: ${inventory.size} entries, ${personal} personal.`, "");
  lines.push(blocked ? "**❌ The inventory does not match the schema: the prod release is blocked.**" : "**✅ Every column of the schema is classified.**", "");
  if (gaps.missing.length > 0) {
    lines.push("### Columns not classified", "");
    for (const c of gaps.missing) lines.push(`- ${code(`${c.table_name}.${c.column_name}`)} (${c.type}${c.refers_to ? `, references ${c.refers_to}` : ""})`);
    lines.push("");
  }
  if (gaps.stale.length > 0) {
    lines.push("### Entries naming a column that no longer exists", "");
    for (const name of gaps.stale) lines.push(`- ${code(name)}`);
    lines.push("");
  }
  if (gaps.notIdentifier.length > 0) {
    lines.push("### Columns referencing users that are not classified as `identifier`", "");
    for (const name of gaps.notIdentifier) lines.push(`- ${code(name)}`);
    lines.push("");
  }
  if (gaps.missing.length > 0) {
    lines.push("### AI proposals", "");
    if (ai.yaml) lines.push("To review, then add to `gdpr/inventory.yaml` in a PR:", "", "```yaml", ai.yaml.trimEnd(), "```", "");
    if (ai.error) lines.push(`No proposal${ai.yaml ? " for some columns" : ""}: ${ai.error}.`, "");
  }
  lines.push(previousRef ? `### Changes since ${code(previousRef)}` : "### Changes", "");
  if (!previousRef) {
    lines.push("No previous release carries an inventory: every entry is new and must be reviewed.", "");
  } else if (changes.added.length + changes.removed.length + changes.changed.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("Review them before approving the Prod release.", "", "| Column | Change |", "| --- | --- |");
    for (const entry of changes.added) lines.push(`| ${code(`${entry.table}.${entry.column}`)} | added: ${describeEntry(entry)}${entry.note ? ` (${entry.note})` : ""} |`);
    for (const { name, fields } of changes.changed) {
      lines.push(`| ${code(name)} | ${fields.map((f) => `${f.field}: ${f.from ?? "—"} → ${f.to ?? "—"}`).join("; ")} |`);
    }
    for (const name of changes.removed) lines.push(`| ${code(name)} | removed |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv, env = process.env, makeClient = (options) => new Anthropic(options)) {
  const [inventoryFile, schemaFile, reportDir, previousFile, previousRef] = argv;
  if (!inventoryFile || !schemaFile || !reportDir) {
    console.error("usage: node check.mjs <inventory.yaml> <schema.json> <report dir> [<previous inventory.yaml> <previous ref>]");
    return 2;
  }
  mkdirSync(reportDir, { recursive: true });
  const inventoryText = readFileSync(inventoryFile, "utf8");
  const { errors, entries } = parseInventory(inventoryText);
  if (errors.length > 0) {
    const text = `## GDPR inventory\n\n**❌ ${code(inventoryFile)} is invalid:**\n\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
    writeFileSync(join(reportDir, "summary.md"), text);
    console.error(text);
    return 2;
  }
  const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  if (!Array.isArray(schema) || schema.length === 0) {
    console.error(`${schemaFile} holds no column: the schema was not migrated?`);
    return 2;
  }
  const gaps = compare(entries, schema);

  // The previous inventory may be invalid or absent (first release): its entries only feed the diff.
  let previous = new Map();
  let ref = null;
  if (previousFile && existsSync(previousFile)) {
    previous = parseInventory(readFileSync(previousFile, "utf8")).entries;
    ref = previousRef || previousFile;
  }
  const changes = diff(previous, entries);

  const ai = { yaml: null, error: null, model: null, usage: null };
  if (gaps.missing.length > 0) {
    const settings = aiSettings(env);
    ai.model = settings.model;
    if (!settings.enabled) {
      ai.error = settings.reason;
    } else {
      const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? "").trim();
      const client = makeClient(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
      const result = await propose(gaps.missing, { client, model: settings.model, inventoryText });
      ai.error = result.error;
      ai.usage = result.usage;
      if (result.proposals.length > 0) {
        ai.yaml = proposalsYaml(result.proposals, settings.model);
        writeFileSync(join(reportDir, "proposals.yaml"), ai.yaml);
      }
    }
  }

  const text = summary({ inventory: entries, schema, gaps, changes, previousRef: ref, ai, label: env.GDPR_SCHEMA_LABEL });
  writeFileSync(join(reportDir, "summary.md"), text);
  writeFileSync(
    join(reportDir, "report.json"),
    `${JSON.stringify({ gaps: { ...gaps, missing: gaps.missing.map((c) => `${c.table_name}.${c.column_name}`) }, changes, previous_ref: ref, ai: { model: ai.model, error: ai.error, usage: ai.usage } }, null, 2)}\n`,
  );
  console.log(text);
  return gaps.missing.length + gaps.stale.length + gaps.notIdentifier.length > 0 ? 1 : 0;
}

// realpath: run through a symlinked checkout, argv[1] and import.meta.url differ.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
