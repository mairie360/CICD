#!/usr/bin/env node
// RGAA engine entry point (MAIR-317), run in the runner container of the consumer's
// accessibility stack:
//
//   node run.mjs <rgaa.yaml> <report dir>
//
// Plays every state of the scope, captures and checks it (MAIR-318), and writes in <report dir>:
//   report.json        target, per-criterion results (failures, items to review), states with
//                      their snapshot fingerprint, elements of undeclared criteria
//   summary.md         appended to the job summary by the workflow
//   states/<id>/       page.html (normalized), aria.yml, desktop.png, mobile-320.png, checks.json
//   failures/<id>.png  states that could not be reached
// Exit codes: 0 every state reached and the rate gate passed, 1 a state failed or an element needs
// a criterion rgaa.yaml does not declare, 2 invalid rgaa.yaml / RGAA_MIN_RATE or engine error,
// 3 the CI rate is below RGAA_MIN_RATE (default 60 %, MAIR-319; see rate.mjs).
export const EXIT = { ok: 0, failed: 1, invalid: 2, below_rate: 3 };
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { aiSettings, createClient, estimatedRate, judge, loadCache, proposals, saveCache } from "./ai.mjs";
import { captureState } from "./capture.mjs";
import { aggregate, loadCriteria } from "./criteria.mjs";
import { computeRate, criterionStatus, minRate } from "./rate.mjs";
import { playState } from "./states.mjs";
import { loadScope } from "./validate.mjs";

export const REPORT_VERSION = 1;
export const DEFAULT_CONCURRENCY = 4;

// RGAA_CONCURRENCY: states played at the same time (default 4, the vCPUs of a GitHub runner).
export function parallelism(env = process.env) {
  const raw = (env.RGAA_CONCURRENCY ?? "").trim();
  if (raw === "") return DEFAULT_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error(`RGAA_CONCURRENCY must be an integer between 1 and 16, got "${raw}"`);
  }
  return value;
}

// Runs `fn` on every item with at most `limit` at once; results keep the order of `items`.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

export function summarize(report) {
  const failed = report.states.filter((s) => !s.reached);
  const { rate } = report;
  const verdict =
    rate.value === null
      ? `no criterion decided automatically, nothing to gate (minimum ${rate.min} %)`
      : `**${rate.value} %** (${rate.validated} validated / ${rate.validated + rate.invalidated} decided), minimum ${rate.min} %: ${rate.passed ? "passed" : "**below the minimum**"}`;
  const lines = [
    "## RGAA accessibility",
    "",
    `CI rate ${verdict}. ${rate.to_review} criteria go to the RGAA review.`,
    "",
    `Target \`${report.target}\`: ${report.states.length - failed.length}/${report.states.length} state(s) reached, ` +
      `${report.criteria.length} applicable criteria.`,
    "",
    "| State | Result | Fingerprint |",
    "| --- | --- | --- |",
    ...report.states.map((s) =>
      s.reached
        ? `| \`${s.id}\` | reached | \`${s.fingerprint.slice(0, 12)}\` |`
        : `| \`${s.id}\` | **failed**${s.failed_step === undefined ? "" : ` at step ${s.failed_step + 1}`}: ${cell(s.error)} | |`,
    ),
  ];
  if (report.undeclared.length > 0) {
    lines.push("", "### Undeclared criteria", "", "| Criterion | State | Element | Problem |", "| --- | --- | --- | --- |");
    for (const u of report.undeclared) lines.push(`| ${u.criterion} | \`${u.state}\` | \`${cell(u.target)}\` | ${cell(u.message)} |`);
  }
  lines.push("", "### Criteria", "", "| Criterion | Status | Level | Automated coverage | Failures | To review |", "| --- | --- | --- | --- | --- | --- |");
  for (const c of report.criteria) {
    const status = c.status === "invalidated" ? "**invalidated**" : c.status.replace("_", " ");
    lines.push(`| ${c.id} | ${status} | ${c.level} | ${c.coverage} | ${c.failures.length || ""} | ${c.review.length || ""} |`);
  }
  if (report.ai?.enabled && report.ai.criteria) {
    const { ai } = report;
    const est = ai.estimated_rate.value === null ? "n/a" : `${ai.estimated_rate.value} %`;
    const cost = ai.stats.usage.cost_usd === undefined ? "" : `, ~$${ai.stats.usage.cost_usd}`;
    lines.push(
      "",
      "### AI pre-audit (proposals, not gating)",
      "",
      `Estimated rate with the AI proposals: **${est}**. Model \`${ai.model}\`: ${ai.stats.elements} elements, ${ai.stats.judged} judged, ${ai.stats.cached} from cache${cost}.`,
      "",
      "| Criterion | Proposal | Elements | Valid | Invalid | Uncertain |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const [id, c] of Object.entries(ai.criteria)) {
      lines.push(`| ${id} | ${c.proposal} | ${c.elements} | ${c.valid} | ${c.invalid.length} | ${c.uncertain} |`);
    }
    for (const [id, c] of Object.entries(ai.criteria).filter(([, c]) => c.invalid.length > 0)) {
      lines.push("", `**${id}** (AI)`, "");
      for (const f of c.invalid.slice(0, 5)) lines.push(`- \`${f.state}\` · \`${cell(f.target)}\` « ${cell(f.name)} »: ${cell(f.reason)}`);
      if (c.invalid.length > 5) lines.push(`- … ${c.invalid.length - 5} more in report.json`);
    }
  } else if (report.ai?.error) {
    lines.push("", `AI pre-audit failed: ${cell(report.ai.error)}`);
  }
  const failing = report.criteria.filter((c) => c.failures.length > 0);
  if (failing.length > 0) {
    lines.push("", "### Failures (first 5 per criterion)", "");
    for (const c of failing) {
      lines.push(`**${c.id}**`, "");
      for (const f of c.failures.slice(0, 5)) lines.push(`- \`${f.state}\` · ${f.check} · \`${cell(f.target)}\`: ${cell(f.message)}`);
      if (c.failures.length > 5) lines.push(`- … ${c.failures.length - 5} more in report.json`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

// AI pre-audit (MAIR-320): proposals and an estimated rate, never part of the gate. Skipped without
// an API key; an error is reported in the summary and does not fail the run.
async function preAudit(ai, items, results) {
  if (!ai.enabled) {
    if (items.length === 0) console.log(`AI pre-audit skipped: ${ai.reason}`);
    return { enabled: false, reason: ai.reason };
  }
  const cache = loadCache(ai.cache);
  try {
    const { verdicts, stats } = await judge(items, { client: createClient(), model: ai.model, cache });
    saveCache(ai.cache, cache);
    const criteria = proposals(items, verdicts);
    const cost = stats.usage.cost_usd === undefined ? "" : `, ~$${stats.usage.cost_usd}`;
    console.log(`AI pre-audit (${ai.model}): ${stats.elements} elements, ${stats.judged} judged, ${stats.cached} from cache${cost}`);
    return { enabled: true, model: ai.model, cache: ai.cache || null, stats, criteria, estimated_rate: estimatedRate(results, criteria) };
  } catch (error) {
    saveCache(ai.cache, cache);
    console.log(`::warning title=RGAA AI::pre-audit failed: ${error.message.split("\n")[0]}`);
    return { enabled: true, model: ai.model, error: error.message.split("\n")[0] };
  }
}

async function main([scopeFile, reportDir]) {
  if (!scopeFile || !reportDir) {
    console.error("usage: node run.mjs <rgaa.yaml> <report dir>");
    return EXIT.invalid;
  }
  let scope;
  let min;
  try {
    scope = loadScope(scopeFile);
  } catch (error) {
    for (const detail of error.details ?? [error.message]) console.log(`::error file=rgaa.yaml::${detail}`);
    return EXIT.invalid;
  }
  try {
    min = minRate();
  } catch (error) {
    console.log(`::error title=RGAA::${error.message}`);
    return EXIT.invalid;
  }
  let concurrency;
  try {
    concurrency = parallelism();
  } catch (error) {
    console.log(`::error title=RGAA::${error.message}`);
    return 2;
  }

  const criteria = loadCriteria();
  const ai = aiSettings();
  const aiItems = [];
  mkdirSync(join(reportDir, "failures"), { recursive: true });
  const browser = await chromium.launch();
  const states = [];
  const undeclared = [];
  try {
    // States run in parallel, each in its own browser context, then are reported in scope order
    // (undeclared items too), so the report does not depend on the scheduling.
    const playOne = async (state) => {
      const dir = join(reportDir, "states", state.id);
      const found = [];
      const result = await playState(browser, scope, state, {
        onReached: async (page, res) => {
          const capture = await captureState(page, { scope, criteria, dir, stateId: state.id, ai: ai.enabled });
          aiItems.push(...capture.aiItems);
          writeFileSync(join(dir, "checks.json"), `${JSON.stringify(capture.checks, null, 2)}\n`);
          res.fingerprint = capture.fingerprint;
          res.files = Object.fromEntries(
            Object.entries(capture.files).map(([k, v]) => [k, Array.isArray(v) ? v.map((f) => `states/${state.id}/${f}`) : `states/${state.id}/${v}`]),
          );
          res.checks = capture.checks;
          found.push(...capture.undeclared.map((u) => ({ state: state.id, ...u })));
        },
        onFailure: (page) => page.screenshot({ path: join(reportDir, "failures", `${state.id}.png`), fullPage: true }),
      });
      console.log(`${result.reached ? "ok    " : "FAILED"} ${state.id}${result.error ? `: ${result.error}` : ""}`);
      return { result, found };
    };
    const results = await mapLimit(scope.states, concurrency, playOne);
    for (const { result, found } of results) {
      states.push(result);
      undeclared.push(...found);
    }
  } finally {
    await browser.close();
  }

  const results = aggregate(scope, criteria, states).map((c) => ({ ...c, status: criterionStatus(c) }));
  const aiReport = await preAudit(ai, aiItems, results);
  const report = {
    version: REPORT_VERSION,
    target: scope.target,
    rate: computeRate(results, min),
    criteria: results,
    states: states.map(({ checks, ...rest }) => rest),
    undeclared,
    ai: aiReport,
  };
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(reportDir, "summary.md"), summarize(report));
  for (const u of undeclared) console.log(`::error title=RGAA::${u.state}: ${u.message} (${u.target})`);
  const { rate } = report;
  console.log(`CI rate: ${rate.value === null ? "nothing decided" : `${rate.value} %`} (minimum ${rate.min} %)`);
  if (!states.every((s) => s.reached) || undeclared.length > 0) return EXIT.failed;
  if (!rate.passed) {
    console.log(`::error title=RGAA::CI rate ${rate.value} % is below the minimum of ${rate.min} %: ${rate.invalidated} criteria invalidated, see the job summary`);
    return EXIT.below_rate;
  }
  return EXIT.ok;
}

if (process.argv[1]?.endsWith("run.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}
