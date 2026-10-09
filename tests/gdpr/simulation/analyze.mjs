// Gate of the GDPR simulation (MAIR-497), after the run, before the Prod approval.
//
// Usage: node simulation/analyze.mjs <run dir> <report dir> [<gdpr-accepted-risks.yaml>]
//   <run dir>/personas.json, sensitive.json   simulate.mjs
//   <run dir>/containers.log                  `docker compose logs --no-color` of the whole stack
//   <run dir>/browser/console.json            [{ state, type, text }]   (fronts, RGAA engine)
//   <run dir>/browser/storage.json            [{ state, area, key, value }]
//   <run dir>/db/{erasure,retention,content}.sql.json   psql output of sql.mjs's queries
//   <run dir>/traces.jsonl                    OpenTelemetry collector `file` exporter (MAIR-501)
//   <run dir>/usage.json                      usage ledger the instance would export (MAIR-501)
// Missing browser, db, traces or usage files are reported as not checked.
//
// Deterministic checks: a persona value (or a captured token) in any log, console message,
// browser storage entry, span or usage ledger blocks; so does a span attribute that identifies the
// caller (user id, session, Authorization, query string), a ledger key that names a person, and a
// Redis key without TTL, above its maximum or of an undeclared prefix (<run dir>/redis/keys.tsv,
// MAIR-499). Values of an erased persona outside the `keep` columns and rows
// past their retention are reported as expected failures until the erasure is implemented
// (MAIR-289); GDPR_SIMULATION_ERASURE=enforce makes them block.
// AI review (ai.mjs): a "high" verdict blocks unless its fingerprint is accepted in
// gdpr-accepted-risks.yaml. Exit 0 / 1 blocked / 2 invalid input.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadCache, saveCache } from "../contract/ai.mjs";
import { needles } from "../marker/marker.mjs";
import { mask, parseLogs, serviceMatches } from "../marker/scan.mjs";
import { parseAccepted } from "./accepted.mjs";
import { aiSettings, review } from "./ai.mjs";
import { checkRedis, parseKeys } from "./redis.mjs";
import { fingerprintOf, groupTemplates, templateOf } from "./templates.mjs";
import { forbiddenAttributes, forbiddenLedgerKeys, parseTraces, spanText } from "./traces.mjs";

export const RUNNER_SERVICES = ["gdpr-simulation", "gdpr-marker"];
const readJson = (file, fallback = null) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "null") ?? fallback : fallback);

function allNeedles(personas, sensitive) {
  const list = [];
  for (const p of personas) for (const n of needles(p.values)) list.push({ ...n, persona: p.id });
  for (const s of sensitive) for (const n of needles({}, s.sensitive)) list.push({ ...n, persona: s.persona });
  return list;
}

function find(text, list) {
  const lower = text.toLowerCase();
  return list.find((n) => lower.includes(n.text.toLowerCase())) ?? null;
}

export function analyze(run, { accepted, verdicts = new Map(), enforceErasure = false }) {
  const list = allNeedles(run.personas, run.sensitive);
  const deterministic = [];
  const masked = [];
  for (const line of run.logs) {
    if (RUNNER_SERVICES.some((s) => serviceMatches(line.service, s))) continue;
    if (run.ignore.some((i) => serviceMatches(line.service, i.service))) continue;
    const hit = find(line.text, list);
    const text = mask(line.text, list);
    if (hit) deterministic.push({ check: "log", where: line.service, persona: hit.persona, field: hit.field, excerpt: text.slice(0, 240) });
    masked.push({ service: line.service, text });
  }
  for (const m of run.console ?? []) {
    const hit = find(m.text, list);
    if (hit) deterministic.push({ check: "console", where: m.state, persona: hit.persona, field: hit.field, excerpt: mask(m.text, list).slice(0, 240) });
  }
  for (const s of run.storage ?? []) {
    const hit = find(`${s.key}=${s.value}`, list);
    if (hit) deterministic.push({ check: "storage", where: `${s.state} ${s.area}Storage`, persona: hit.persona, field: hit.field, excerpt: mask(`${s.key}=${s.value}`, list).slice(0, 240) });
  }
  // Every Redis key expires, within its declared prefix (MAIR-499): blocking.
  if (run.redisKeys) deterministic.push(...checkRedis(run.redisKeys, run.redisPrefixes ?? {}));
  const spans = [];
  for (const span of run.traces ?? []) {
    const text = spanText(span);
    const hit = find(text, list);
    if (hit) deterministic.push({ check: "trace", where: `${span.service} ${span.name}`, persona: hit.persona, field: hit.field, excerpt: mask(text, list).slice(0, 240) });
    for (const key of forbiddenAttributes(span)) {
      deterministic.push({ check: "trace attribute", where: `${span.service} ${span.name}`, persona: "", field: key, excerpt: `attribute ${key} identifies the caller or carries its input` });
    }
    spans.push({ service: span.service, text: mask(text, list) });
  }
  if (run.usage != null) {
    const text = JSON.stringify(run.usage);
    const hit = find(text, list);
    if (hit) deterministic.push({ check: "usage", where: "usage ledger", persona: hit.persona, field: hit.field, excerpt: mask(text, list).slice(0, 240) });
    for (const key of forbiddenLedgerKeys(run.usage)) {
      deterministic.push({ check: "usage field", where: "usage ledger", persona: "", field: key, excerpt: `key ${key} names a person` });
    }
  }
  const expected = [
    ...(run.erasure ?? []).map((e) => ({ check: "erasure", where: `${e.table_name}.${e.column_name}`, persona: e.persona, field: e.field, excerpt: `${e.rows} row(s)` })),
    ...(run.retention ?? []).map((r) => ({ check: "retention", where: r.table_name, excerpt: `${r.rows} row(s) older than ${r.retention}` })),
  ];

  // AI items: one per log template, console template, storage key, database value.
  const items = [
    ...groupTemplates(masked).map((t) => ({ fingerprint: t.fingerprint, kind: "log", where: t.service, text: t.template, count: t.count })),
    ...groupTemplates(spans).map((t) => ({ fingerprint: fingerprintOf("trace", t.service, t.template), kind: "trace", where: t.service, text: t.template, count: t.count })),
    ...dedupe((run.console ?? []).map((m) => {
      const text = templateOf(mask(m.text, list));
      return { fingerprint: fingerprintOf("console", m.type, text), kind: "console", where: m.state, text };
    })),
    ...dedupe((run.storage ?? []).map((s) => {
      const text = templateOf(mask(`${s.area}Storage ${s.key}=${s.value}`, list));
      return { fingerprint: fingerprintOf("storage", text), kind: "storage", where: s.state, text };
    })),
    ...dedupe((run.content ?? []).map((c) => {
      const text = templateOf(mask(String(c.value), list));
      return { fingerprint: fingerprintOf("db", c.table_name, c.column_name, text), kind: "database", where: `${c.table_name}.${c.column_name}`, text };
    })),
  ];
  const findings = items
    .map((item) => ({ ...item, ...(verdicts.get(item.fingerprint) ?? { risk: null, justification: null }) }))
    .map((f) => ({ ...f, accepted: accepted.get(f.fingerprint) ?? null }));
  const blockingAi = findings.filter((f) => f.risk === "high" && !f.accepted);
  const blocked = deterministic.length > 0 || blockingAi.length > 0 || (enforceErasure && expected.length > 0);
  return { deterministic, expected, findings, blockingAi, blocked, enforceErasure, logLines: run.logs.length, spanCount: spans.length };
}

function dedupe(items) {
  return [...new Map(items.map((i) => [i.fingerprint, i])).values()];
}

const code = (text) => `\`${String(text).replaceAll("`", "'").replaceAll("|", "\\|")}\``;

export function summary(result, { ai, notChecked }) {
  const lines = ["## GDPR simulation", ""];
  lines.push(result.blocked ? "**❌ The simulation blocks the Prod release.**" : "**✅ Nothing blocks the Prod release.**", "");
  lines.push(`${result.logLines} log lines, ${result.spanCount} spans, ${result.findings.length} items reviewed.${notChecked.length ? ` Not checked: ${notChecked.join(", ")}.` : ""}`, "");
  if (result.deterministic.length > 0) {
    lines.push("### Persona values found (blocking)", "", "| Check | Where | Persona | Field | Excerpt |", "| --- | --- | --- | --- | --- |");
    for (const d of result.deterministic.slice(0, 50)) lines.push(`| ${d.check} | ${code(d.where)} | ${d.persona ?? ""} | ${d.field ?? ""} | ${code(d.excerpt)} |`);
    lines.push("");
  }
  if (result.expected.length > 0) {
    lines.push(`### Erasure and retention (${result.enforceErasure ? "blocking" : "expected failures until MAIR-289"})`, "", "| Check | Where | Persona | Detail |", "| --- | --- | --- | --- |");
    for (const e of result.expected) lines.push(`| ${e.check} | ${code(e.where)} | ${e.persona ?? ""} ${e.field ?? ""} | ${e.excerpt} |`);
    lines.push("");
  }
  lines.push("### AI review", "");
  if (!ai.enabled) lines.push(`Not asked: ${ai.reason}.`, "");
  else {
    lines.push(`${code(ai.model)}: ${ai.asked} asked, ${ai.cached} from the cache.${ai.error ? ` Some items got no verdict: ${ai.error}.` : ""}`, "");
    const shown = result.findings.filter((f) => f.risk === "high" || f.risk === "medium");
    if (shown.length > 0) {
      lines.push("| Risk | Kind | Where | Item | Why | Fingerprint |", "| --- | --- | --- | --- | --- | --- |");
      for (const f of shown.sort((a, b) => (a.risk === "high" ? -1 : 1) - (b.risk === "high" ? -1 : 1))) {
        const risk = f.risk === "high" ? (f.accepted ? `high, accepted (${f.accepted.author}, ${f.accepted.date})` : "**high**") : "medium";
        lines.push(`| ${risk} | ${f.kind} | ${code(f.where)} | ${code(f.text.slice(0, 160))} | ${f.justification ?? ""} | ${code(f.fingerprint)} |`);
      }
      lines.push("", "Accept a risk in `gdpr-accepted-risks.yaml` (fingerprint, reason, date, author), or fix it.", "");
    } else lines.push("No medium or high risk.", "");
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv, { env = process.env, client = null, log = console.log } = {}) {
  const [runDir, reportDir, acceptedFile] = argv;
  if (!runDir || !reportDir) {
    console.error("usage: node simulation/analyze.mjs <run dir> <report dir> [<gdpr-accepted-risks.yaml>]");
    return 2;
  }
  const personasFile = join(runDir, "personas.json");
  const logsFile = join(runDir, "containers.log");
  if (!existsSync(personasFile) || !existsSync(logsFile)) {
    console.error(`${personasFile} and ${logsFile} are required`);
    return 2;
  }
  const { errors, accepted } = parseAccepted(acceptedFile && existsSync(acceptedFile) ? readFileSync(acceptedFile, "utf8") : null);
  if (errors.length > 0) {
    console.error(`${acceptedFile} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  const { personas, ignore = [] } = readJson(personasFile);
  const notChecked = [];
  const optional = (file, label) => {
    if (!existsSync(file)) notChecked.push(label);
    return readJson(file, []);
  };
  const run = {
    personas,
    ignore,
    sensitive: readJson(join(runDir, "sensitive.json"), []),
    logs: parseLogs(readFileSync(logsFile, "utf8")),
    console: optional(join(runDir, "browser", "console.json"), "browser console"),
    storage: optional(join(runDir, "browser", "storage.json"), "browser storage"),
    erasure: optional(join(runDir, "db", "erasure.sql.json"), "erasure"),
    retention: optional(join(runDir, "db", "retention.sql.json"), "retention"),
    content: optional(join(runDir, "db", "content.sql.json"), "database content"),
    redisKeys: existsSync(join(runDir, "redis", "keys.tsv")) ? parseKeys(readFileSync(join(runDir, "redis", "keys.tsv"), "utf8")) : null,
    redisPrefixes: readJson(join(runDir, "redis_prefixes.json"), {}),
    traces: existsSync(join(runDir, "traces.jsonl")) ? parseTraces(readFileSync(join(runDir, "traces.jsonl"), "utf8")) : (notChecked.push("traces"), []),
    usage: existsSync(join(runDir, "usage.json")) ? readJson(join(runDir, "usage.json")) : (notChecked.push("usage ledger"), null),
  };
  if (!run.redisKeys) notChecked.push("redis keys");
  const enforceErasure = (env.GDPR_SIMULATION_ERASURE ?? "").trim() === "enforce";
  const settings = aiSettings(env);
  const ai = { ...settings, asked: 0, cached: 0, error: null };
  let verdicts = new Map();
  if (settings.enabled) {
    const items = analyze(run, { accepted }).findings;
    const cache = loadCache(settings.cache);
    const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? "").trim();
    const out = await review(items, {
      client: client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) }),
      model: settings.model,
      cache,
    });
    saveCache(settings.cache, cache);
    verdicts = out.verdicts;
    Object.assign(ai, { asked: out.asked, cached: out.cached, error: out.error, usage: out.usage });
  }
  const result = analyze(run, { accepted, verdicts, enforceErasure });
  mkdirSync(reportDir, { recursive: true });
  const text = summary(result, { ai, notChecked });
  writeFileSync(join(reportDir, "summary.md"), text);
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify({ blocked: result.blocked, not_checked: notChecked, deterministic: result.deterministic, expected_failures: result.expected, findings: result.findings, ai: { model: ai.model, enabled: ai.enabled, asked: ai.asked, cached: ai.cached, error: ai.error } }, null, 2)}\n`);
  log(text);
  return result.blocked ? 1 : 0;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
