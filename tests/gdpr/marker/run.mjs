// Runner of the log marker test (MAIR-290), the command of the `gdpr-marker` service of a repo's
// marker stack (through run.sh). Generates the marker user, waits for the service under test,
// plays the journey of gdpr-marker.yaml and writes <report dir>/marker.json for scan.mjs.
// Its own output only names the steps, never a value.
//
// Usage: node marker/run.mjs <gdpr-marker.yaml> <report dir>
// Exit 0: journey played. Exit 1: a step failed or the service never answered. Exit 2: invalid file.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadJourney, play, usedFields, waitFor } from "./journey.mjs";
import { generateMarker } from "./marker.mjs";

export async function main(argv, { env = process.env, fetchImpl = fetch, waitTimeoutMs = 180000, log = console.log } = {}) {
  const [journeyFile, reportDir] = argv;
  if (!journeyFile || !reportDir) {
    console.error("usage: node marker/run.mjs <gdpr-marker.yaml> <report dir>");
    return 2;
  }
  const { errors, journey } = loadJourney(readFileSync(journeyFile, "utf8"));
  if (errors.length > 0) {
    console.error(`${journeyFile} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  mkdirSync(reportDir, { recursive: true });
  const marker = generateMarker();
  let results = [];
  let sensitive = {};
  if (journey.wait && !(await waitFor(`${journey.target}${journey.wait}`, { fetchImpl, timeoutMs: waitTimeoutMs }))) {
    results = [{ name: "wait for the service", method: "GET", path: journey.wait, expected: null, status: null, ok: false, error: `no answer below 400 within ${Math.round(waitTimeoutMs / 1000)} s` }];
    log(`FAIL ${journey.target}${journey.wait} never answered`);
  } else {
    ({ results, sensitive } = await play(journey, { marker, env, fetchImpl, log }));
  }
  const skipped = journey.steps.length - results.filter((r) => r.name !== "wait for the service").length;
  writeFileSync(
    join(reportDir, "marker.json"),
    `${JSON.stringify({ marker, sensitive, ignore: journey.ignore, used_fields: usedFields(journey), journey: { results, skipped: Math.max(0, skipped) } }, null, 2)}\n`,
  );
  return results.every((r) => r.ok) ? 0 : 1;
}

// realpath: run through a symlinked checkout, argv[1] and import.meta.url differ.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
