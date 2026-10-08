// GDPR checklist of a pull request (MAIR-295), run by the `gdpr-pr` reusable workflow.
//
// Usage: node pr/check.mjs <PR body file> <changed files list> <diff file> <inventory.yaml> <report dir> [<inventory path in this repo>]
//
// Exit 0: the question is answered and followed. Exit 1: not answered, or "Yes" without the
// inventory. Exit 2: invalid input. Claude's warning never changes it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { aiSettings } from "../contract/ai.mjs";
import { loadCache, reviewPullRequest, saveCache, warning } from "./ai.mjs";
import { parseAnswer, verdict } from "./checklist.mjs";

const code = (text) => `\`${text}\``;

export function summary({ parsed, result, ai, warn }) {
  const answer = parsed.answer === null ? "not answered" : parsed.answer === "yes" ? "Yes" : "No";
  const lines = ["## GDPR checklist", "", `Personal data: **${answer}**${parsed.answer === "yes" && parsed.inventory ? ` (inventory: ${parsed.inventory})` : ""}.`, ""];
  lines.push(result.ok ? "**✅ The question is answered and followed.**" : "**❌ The checklist is not complete:**", "");
  for (const reason of result.reasons) lines.push(`- ${reason}`);
  if (result.reasons.length > 0) lines.push("");
  lines.push("### AI review (not blocking)", "");
  if (!ai.enabled) lines.push(`Not asked: ${ai.reason}.`);
  else if (ai.error) lines.push(`No review: ${ai.error}.`);
  else if (ai.review) {
    const r = ai.review;
    lines.push(`${code(ai.model)}${ai.cached ? " (cached)" : ""}: ${r.touches_personal_data ? `touches personal data (${r.confidence} confidence)` : "does not touch personal data"}${r.inventory_change_needed ? ", the inventory needs a change" : ""}.${ai.truncated ? " The diff was truncated." : ""}`);
    if (warn) lines.push("", `⚠️ ${warn}.`);
    if (r.findings.length > 0) {
      lines.push("", "| File | Why |", "| --- | --- |");
      for (const f of r.findings.slice(0, 15)) lines.push(`| ${code(f.file)} | ${f.reason.replaceAll("|", "\\|")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv, { env = process.env, client = null, log = console.log } = {}) {
  const [bodyFile, changedFile, diffFile, inventoryFile, reportDir, inventoryPath] = argv;
  if (!bodyFile || !changedFile || !diffFile || !inventoryFile || !reportDir) {
    console.error("usage: node pr/check.mjs <body> <changed files> <diff> <inventory.yaml> <report dir> [<inventory path in this repo>]");
    return 2;
  }
  for (const file of [bodyFile, changedFile, diffFile, inventoryFile]) {
    if (!existsSync(file)) {
      console.error(`${file}: missing`);
      return 2;
    }
  }
  const parsed = parseAnswer(readFileSync(bodyFile, "utf8"));
  const changedFiles = readFileSync(changedFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const result = verdict(parsed, { changedFiles, inventoryPath: inventoryPath || null });

  const settings = aiSettings(env);
  const ai = { ...settings, review: null, cached: false, error: null, truncated: false };
  let warn = null;
  if (settings.enabled) {
    const cache = loadCache(settings.cache);
    const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? "").trim();
    const out = await reviewPullRequest({
      client: client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) }),
      model: settings.model,
      inventoryText: readFileSync(inventoryFile, "utf8"),
      diff: readFileSync(diffFile, "utf8"),
      answer: parsed.answer,
      cache,
    });
    Object.assign(ai, out);
    saveCache(settings.cache, cache);
    warn = warning(parsed.answer, ai.review, { inventoryChanged: Boolean(inventoryPath) && changedFiles.includes(inventoryPath) });
  }

  mkdirSync(reportDir, { recursive: true });
  const text = summary({ parsed, result, ai, warn });
  writeFileSync(join(reportDir, "summary.md"), text);
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify({ answer: parsed.answer, inventory: parsed.inventory, ok: result.ok, reasons: result.reasons, ai: { model: ai.model, enabled: ai.enabled, cached: ai.cached, review: ai.review, error: ai.error }, warning: warn }, null, 2)}\n`);
  if (warn) console.log(`::warning title=GDPR checklist::${warn}`);
  for (const reason of result.reasons) console.log(`::error title=GDPR checklist::${reason}`);
  log(text);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
