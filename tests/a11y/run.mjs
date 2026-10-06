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
// Exit codes: 0 every state reached and checked, 1 a state failed or an element needs a criterion
// rgaa.yaml does not declare, 2 invalid rgaa.yaml or engine error. Failing criteria do not fail
// the run by themselves: the rate gate does (MAIR-319).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { captureState } from "./capture.mjs";
import { aggregate, loadCriteria } from "./criteria.mjs";
import { playState } from "./states.mjs";
import { loadScope } from "./validate.mjs";

export const REPORT_VERSION = 1;

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

export function summarize(report) {
  const failed = report.states.filter((s) => !s.reached);
  const lines = [
    "## RGAA accessibility",
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
  lines.push("", "### Criteria", "", "| Criterion | Level | Automated coverage | Failures | To review |", "| --- | --- | --- | --- | --- |");
  for (const c of report.criteria) {
    lines.push(`| ${c.id} | ${c.level} | ${c.coverage} | ${c.failures.length || ""} | ${c.review.length || ""} |`);
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

async function main([scopeFile, reportDir]) {
  if (!scopeFile || !reportDir) {
    console.error("usage: node run.mjs <rgaa.yaml> <report dir>");
    return 2;
  }
  let scope;
  try {
    scope = loadScope(scopeFile);
  } catch (error) {
    for (const detail of error.details ?? [error.message]) console.log(`::error file=rgaa.yaml::${detail}`);
    return 2;
  }

  const criteria = loadCriteria();
  mkdirSync(join(reportDir, "failures"), { recursive: true });
  const browser = await chromium.launch();
  const states = [];
  const undeclared = [];
  try {
    for (const state of scope.states) {
      const dir = join(reportDir, "states", state.id);
      const result = await playState(browser, scope, state, {
        onReached: async (page, res) => {
          const capture = await captureState(page, { scope, criteria, dir });
          writeFileSync(join(dir, "checks.json"), `${JSON.stringify(capture.checks, null, 2)}\n`);
          res.fingerprint = capture.fingerprint;
          res.files = Object.fromEntries(
            Object.entries(capture.files).map(([k, v]) => [k, Array.isArray(v) ? v.map((f) => `states/${state.id}/${f}`) : `states/${state.id}/${v}`]),
          );
          res.checks = capture.checks;
          undeclared.push(...capture.undeclared.map((u) => ({ state: state.id, ...u })));
        },
        onFailure: (page) => page.screenshot({ path: join(reportDir, "failures", `${state.id}.png`), fullPage: true }),
      });
      console.log(`${result.reached ? "ok    " : "FAILED"} ${state.id}${result.error ? `: ${result.error}` : ""}`);
      states.push(result);
    }
  } finally {
    await browser.close();
  }

  const report = {
    version: REPORT_VERSION,
    target: scope.target,
    criteria: aggregate(scope, criteria, states),
    states: states.map(({ checks, ...rest }) => rest),
    undeclared,
  };
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(reportDir, "summary.md"), summarize(report));
  for (const u of undeclared) console.log(`::error title=RGAA::${u.state}: ${u.message} (${u.target})`);
  return states.every((s) => s.reached) && undeclared.length === 0 ? 0 : 1;
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
