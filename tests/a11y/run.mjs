#!/usr/bin/env node
// RGAA engine entry point (MAIR-317), run in the runner container of the consumer's
// accessibility stack:
//
//   node run.mjs <rgaa.yaml> <report dir>
//
// Plays every state of the scope and writes <report dir>/report.json and summary.md (appended
// to the job summary by the workflow). Exit codes: 0 all states reached, 1 a state failed,
// 2 invalid rgaa.yaml or engine error.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { playState } from "./states.mjs";
import { loadScope } from "./validate.mjs";

export const REPORT_VERSION = 1;

export function summarize(report) {
  const failed = report.states.filter((s) => !s.reached);
  const lines = [
    "## RGAA accessibility",
    "",
    `Target \`${report.target}\`: ${report.states.length - failed.length}/${report.states.length} state(s) reached, ` +
      `${report.criteria.length} applicable criteria.`,
    "",
    "| State | Result |",
    "| --- | --- |",
    ...report.states.map((s) =>
      s.reached
        ? `| \`${s.id}\` | reached |`
        : `| \`${s.id}\` | **failed**${s.failed_step === undefined ? "" : ` at step ${s.failed_step + 1}`}: ${s.error.replaceAll("|", "\\|")} |`,
    ),
  ];
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

  mkdirSync(join(reportDir, "failures"), { recursive: true });
  const browser = await chromium.launch();
  const states = [];
  try {
    for (const state of scope.states) {
      const result = await playState(browser, scope, state, {
        onFailure: (page) => page.screenshot({ path: join(reportDir, "failures", `${state.id}.png`), fullPage: true }),
      });
      console.log(`${result.reached ? "ok    " : "FAILED"} ${state.id}${result.error ? `: ${result.error}` : ""}`);
      states.push(result);
    }
  } finally {
    await browser.close();
  }

  const report = { version: REPORT_VERSION, target: scope.target, criteria: scope.criteria, states };
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(reportDir, "summary.md"), summarize(report));
  return states.every((s) => s.reached) ? 0 : 1;
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
