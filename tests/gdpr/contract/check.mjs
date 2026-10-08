// OpenAPI contract check (MAIR-291), run by the `gdpr_contract` job of APIs_cicd.yml and
// BFFs-cicd.yml on the spec the run publishes.
//
// Usage: node contract/check.mjs <openapi.json> <inventory.yaml> <report dir> [<gdpr-contract.yaml>]
//
// Exit 0: no response carries a credentials column outside the allowed ones. Exit 1: one does.
// Exit 2: invalid input (spec, inventory or decision file). The AI proposals never change it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { parseInventory } from "../inventory.mjs";
import { aiSettings, loadCache, proposeMappings, saveCache } from "./ai.mjs";
import { check, parseDecisions, responseFields } from "./contract.mjs";

const code = (text) => `\`${text}\``;

export function summary({ result, fields, ai, decisionFile }) {
  const lines = ["## GDPR contract", ""];
  const operations = new Set(fields.map((f) => f.operation)).size;
  lines.push(`${operations} operations, ${fields.length} response fields checked against the credentials columns of the inventory.`, "");
  lines.push(result.violations.length > 0
    ? "**❌ A response carries a credentials column: the prod release is blocked.**"
    : "**✅ No response carries a credentials column outside the allowed ones.**", "");
  if (result.violations.length > 0) {
    lines.push("### Credentials in responses", "", "Remove the field from the response, or allow it in `gdpr-contract.yaml` with the reason.", "");
    lines.push("| Operation | Status | Field | Column |", "| --- | --- | --- | --- |");
    for (const v of result.violations) lines.push(`| ${code(v.operation)} | ${v.status} | ${code(v.pointer)} | ${v.columns.map(code).join(", ")} |`);
    lines.push("");
  }
  if (result.allowed.length > 0) {
    lines.push(`### Allowed by ${code(decisionFile)}`, "", "| Operation | Field | Reason |", "| --- | --- | --- |");
    for (const a of result.allowed) lines.push(`| ${code(a.operation)} | ${code(a.pointer)} | ${a.reason} |`);
    lines.push("");
  }
  if (result.staleAllows.length > 0) {
    lines.push("### Allows that match no response (remove them)", "");
    for (const a of result.staleAllows) lines.push(`- ${code(a.operation)} ${code(a.field)}`);
    lines.push("");
  }
  lines.push("### AI proposals", "");
  if (!ai.enabled) lines.push(`Not asked: ${ai.reason}.`, "");
  else {
    lines.push(`${result.unmapped.length} field names match no column: ${ai.cached} answered from the cache, ${ai.asked} asked to ${code(ai.model)}.`, "");
    if (ai.proposals.length > 0) {
      lines.push("If a field does carry that column, map it under `fields` in `gdpr-contract.yaml` (the check then applies to it):", "");
      lines.push("| Field | Seen in | Proposed column | Why |", "| --- | --- | --- | --- |");
      for (const p of ai.proposals) lines.push(`| ${code(p.field)} | ${p.schemas.slice(0, 3).map(code).join(", ") || "inline"} | ${code(p.column)} | ${p.reason} |`);
      lines.push("");
    } else lines.push("No field name was mapped to a column.", "");
    if (ai.error) lines.push(`Some names got no answer: ${ai.error}.`, "");
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv, { env = process.env, client = null, log = console.log } = {}) {
  const [specFile, inventoryFile, reportDir, decisionFile] = argv;
  if (!specFile || !inventoryFile || !reportDir) {
    console.error("usage: node contract/check.mjs <openapi.json> <inventory.yaml> <report dir> [<gdpr-contract.yaml>]");
    return 2;
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8"));
  } catch (error) {
    console.error(`${specFile}: not a JSON OpenAPI document (${error.message})`);
    return 2;
  }
  const inventoryText = readFileSync(inventoryFile, "utf8");
  const { errors: inventoryErrors, entries } = parseInventory(inventoryText);
  if (inventoryErrors.length > 0) {
    console.error(`${inventoryFile} is invalid:\n${inventoryErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  const decisionText = decisionFile && existsSync(decisionFile) ? readFileSync(decisionFile, "utf8") : null;
  const { errors: decisionErrors, decisions } = parseDecisions(decisionText, entries);
  if (decisionErrors.length > 0) {
    console.error(`${decisionFile} is invalid:\n${decisionErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  const fields = responseFields(spec);
  const result = check(fields, entries, decisions);

  const settings = aiSettings(env);
  const ai = { ...settings, proposals: [], asked: 0, cached: 0, error: null };
  if (settings.enabled && result.unmapped.length > 0) {
    const cache = loadCache(settings.cache);
    const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? "").trim();
    const out = await proposeMappings(result.unmapped, {
      client: client ?? new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
      }),
      model: settings.model, inventoryText, entries, cache,
    });
    Object.assign(ai, out);
    saveCache(settings.cache, cache);
  }

  mkdirSync(reportDir, { recursive: true });
  const text = summary({ result, fields, ai, decisionFile: decisionFile ?? "gdpr-contract.yaml" });
  writeFileSync(join(reportDir, "summary.md"), text);
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify({
    violations: result.violations, allowed: result.allowed, stale_allows: result.staleAllows,
    personal_by_operation: result.personal, unmapped: result.unmapped,
    ai: { model: ai.model, enabled: ai.enabled, proposals: ai.proposals, asked: ai.asked, cached: ai.cached, error: ai.error, usage: ai.usage ?? null },
  }, null, 2)}\n`);
  log(text);
  return result.violations.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
