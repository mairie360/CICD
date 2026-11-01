// Log scan of the marker test (MAIR-290): searches the logs of every container of the stack for
// the marker's values and the sensitive captures of the journey.
//
// Usage: node marker/scan.mjs <report dir>
//   reads  <report dir>/marker.json (written by run.mjs) and <report dir>/containers.log
//          (`docker compose logs --no-color` of the whole stack, written by the repo's script)
//   writes <report dir>/summary.md and <report dir>/report.json (values masked)
// Exit 0: journey played and no value found. Exit 1: a value found, or the journey failed (the
// logs then prove nothing). Exit 2: missing input.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { needles } from "./marker.mjs";

// The runner's own logs only name the steps, and are not the service under test.
export const RUNNER_SERVICE = "gdpr-marker";
const MAX_EXCERPTS = 5;
const EXCERPT_LENGTH = 240;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `docker compose logs --no-color` prefixes each line with "<service>-<n>  | " (or the
// container_name when the service sets one).
// Terminal colour codes (tracing and most loggers colour their output): removed before the
// search, so that a code between two fields neither hides a value nor clutters the excerpt.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function parseLogs(text) {
  return text.replace(ANSI, "").split("\n").filter((line) => line.trim()).map((line, index) => {
    const at = line.indexOf(" | ");
    return at > 0
      ? { number: index + 1, service: line.slice(0, at).trim(), text: line.slice(at + 3) }
      : { number: index + 1, service: "?", text: line };
  });
}

// "mailpit" matches the compose label "mailpit-1" as well as a container named "mailpit".
export function serviceMatches(label, service) {
  return label === service || new RegExp(`^${escapeRegExp(service)}-\\d+$`).test(label);
}

export function mask(text, list) {
  let masked = text;
  for (const needle of [...list].sort((a, b) => b.text.length - a.text.length)) {
    masked = masked.replace(new RegExp(escapeRegExp(needle.text), "gi"), `<${needle.field}>`);
  }
  return masked;
}

function excerpt(text, list, needle) {
  const at = text.toLowerCase().indexOf(needle.text.toLowerCase());
  const start = Math.max(0, at - EXCERPT_LENGTH / 2);
  const cut = text.slice(start, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${mask(cut, list)}${start + EXCERPT_LENGTH < text.length ? "…" : ""}`;
}

// Returns { findings, ignored }: one finding per line and field (the first variant that matched).
export function scan(lines, list, ignore = []) {
  const findings = [];
  const ignored = new Map();
  for (const line of lines) {
    if (serviceMatches(line.service, RUNNER_SERVICE)) continue;
    const lower = line.text.toLowerCase();
    const seen = new Set();
    for (const needle of list) {
      if (seen.has(needle.field) || !lower.includes(needle.text.toLowerCase())) continue;
      seen.add(needle.field);
      const rule = ignore.find((i) => serviceMatches(line.service, i.service));
      if (rule) {
        ignored.set(rule.service, (ignored.get(rule.service) ?? 0) + 1);
        continue;
      }
      findings.push({ service: line.service, line: line.number, field: needle.field, variant: needle.variant, excerpt: excerpt(line.text, list, needle) });
    }
  }
  return { findings, ignored };
}

const code = (text) => `\`${text.replaceAll("`", "'")}\``;

export function summary({ journey, findings, ignored, ignore, usedFields, logLines }) {
  const failed = journey.results.find((r) => !r.ok);
  const lines = ["## GDPR log marker", ""];
  if (failed) {
    lines.push(`**❌ The journey stopped at ${code(failed.name)}: ${failed.error}. The logs prove nothing until it passes.**`, "");
  } else if (findings.length > 0) {
    lines.push(`**❌ The marker's values appear in the logs: ${findings.length} line(s) in ${new Set(findings.map((f) => f.service)).size} service(s).**`, "");
  } else {
    lines.push(`**✅ None of the marker's values appear in the ${logLines} log lines of the stack.**`, "");
  }
  lines.push(`Marker fields sent by the journey: ${usedFields.length > 0 ? usedFields.map(code).join(", ") : "none"}.`);
  const unused = ["email", "first_name", "last_name", "phone", "password"].filter((f) => !usedFields.includes(f));
  if (unused.length > 0) lines.push(`Not sent, so not tested: ${unused.map(code).join(", ")}.`);
  lines.push("");

  if (findings.length > 0) {
    lines.push("### Leaks", "", "A log describes an error by its type and context, never by the value it received.", "");
    const byService = new Map();
    for (const f of findings) {
      if (!byService.has(f.service)) byService.set(f.service, []);
      byService.get(f.service).push(f);
    }
    for (const [service, list] of byService) {
      const fields = [...new Set(list.map((f) => f.field))].join(", ");
      lines.push(`#### ${code(service)}: ${list.length} line(s) (${fields})`, "");
      for (const f of list.slice(0, MAX_EXCERPTS)) lines.push(`- line ${f.line}, ${f.field} (${f.variant}): ${code(f.excerpt)}`);
      if (list.length > MAX_EXCERPTS) lines.push(`- … ${list.length - MAX_EXCERPTS} more in report.json`);
      lines.push("");
    }
  }

  lines.push("### Journey", "", "| Step | Request | Status |", "| --- | --- | --- |");
  for (const r of journey.results) {
    lines.push(`| ${r.name} | ${code(`${r.method} ${r.path}`)} | ${r.ok ? "✅" : "❌"} ${r.status ?? "-"}${r.error ? ` (${r.error})` : ""} |`);
  }
  if (journey.skipped > 0) lines.push("", `${journey.skipped} step(s) not played after the failure.`);
  lines.push("");

  if (ignore.length > 0) {
    lines.push("### Services not scanned", "", "| Service | Reason | Lines with the marker |", "| --- | --- | --- |");
    for (const rule of ignore) lines.push(`| ${code(rule.service)} | ${rule.reason} | ${ignored.get(rule.service) ?? 0} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv) {
  const [reportDir] = argv;
  if (!reportDir) {
    console.error("usage: node marker/scan.mjs <report dir>");
    return 2;
  }
  const markerFile = join(reportDir, "marker.json");
  const logsFile = join(reportDir, "containers.log");
  if (!existsSync(markerFile)) {
    console.error(`${markerFile} is missing: the runner service did not play the journey (see its logs).`);
    return 2;
  }
  if (!existsSync(logsFile)) {
    console.error(`${logsFile} is missing: the script must save \`docker compose logs --no-color\` there before \`down\`.`);
    return 2;
  }
  const run = JSON.parse(readFileSync(markerFile, "utf8"));
  const list = needles(run.marker, run.sensitive);
  const lines = parseLogs(readFileSync(logsFile, "utf8"));
  const { findings, ignored } = scan(lines, list, run.ignore);
  const failed = run.journey.results.some((r) => !r.ok);
  const text = summary({ journey: run.journey, findings, ignored, ignore: run.ignore, usedFields: run.used_fields, logLines: lines.length });
  writeFileSync(join(reportDir, "summary.md"), text);
  writeFileSync(
    join(reportDir, "report.json"),
    `${JSON.stringify({ journey: run.journey, used_fields: run.used_fields, findings, ignored: Object.fromEntries(ignored) }, null, 2)}\n`,
  );
  return failed || findings.length > 0 ? 1 : 0;
}

// realpath: run through a symlinked checkout, argv[1] and import.meta.url differ.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
  const summaryFile = join(process.argv[2] ?? "", "summary.md");
  if (existsSync(summaryFile)) console.log(readFileSync(summaryFile, "utf8"));
}
