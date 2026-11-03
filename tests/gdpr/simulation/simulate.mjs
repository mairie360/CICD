// Driver of the GDPR simulation (MAIR-497), the command of the `gdpr-simulation` runner of a repo's
// simulation stack. Refuses to run outside a test stack (guard.mjs), generates the personas, plays
// the repo's journey (the gdpr-marker.yaml format of MAIR-290) for each of them, then the `erase`
// steps for the personas to erase, and writes <run dir>/personas.json and journeys.json for
// analyze.mjs. A front adds a `browser` section (browse.mjs, MAIR-497): its pages are opened for
// each persona after the journey and before the erase steps, and the browser console, storage and
// privacy findings go to <run dir>/browser/. The rest of the run (back-dated rows, purge, database
// checks) is driven by the repo's script; see the CICD README.
//
// Usage: node simulation/simulate.mjs <gdpr-simulation.yaml> <run dir>
// Exit 0: every journey played. 1: a step failed. 2: invalid file. 3: not a test stack.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { loadJourney, play, waitFor } from "../marker/journey.mjs";
import { browsePersona, loadBrowser } from "./browse.mjs";
import { assertTestStack } from "./guard.mjs";
import { generatePersonas } from "./personas.mjs";

export function loadSimulation(text, baseDir, readFile = (f) => readFileSync(f, "utf8")) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { errors: [`not valid YAML: ${error.message}`], simulation: null };
  }
  const errors = [];
  if (!doc || doc.version !== 1) return { errors: ["the file must be a mapping with `version: 1`"], simulation: null };
  for (const key of Object.keys(doc).filter((k) => !["version", "journey", "personas", "erased", "erase", "ignore", "retention_columns", "back_date", "browser"].includes(k))) errors.push(`unknown key \`${key}\``);
  const personas = doc.personas ?? 4;
  const erased = doc.erased ?? 1;
  if (!Number.isInteger(personas) || personas < 1 || personas > 50) errors.push("`personas` must be between 1 and 50");
  if (!Number.isInteger(erased) || erased < 0 || erased > personas) errors.push("`erased` must be between 0 and `personas`");
  if (typeof doc.journey !== "string") errors.push("`journey` must name the journey file (gdpr-marker.yaml format)");
  if (errors.length > 0) return { errors, simulation: null };
  const journeyDoc = parse(readFile(resolve(baseDir, doc.journey)));
  // The erase steps run after the journey, with its captures: one journey per erased persona.
  const withErase = { ...journeyDoc, steps: [...journeyDoc.steps, ...(doc.erase ?? [])] };
  const plain = loadJourney(stringify(journeyDoc));
  const erasing = loadJourney(stringify(withErase));
  for (const e of [...plain.errors, ...erasing.errors.filter((e) => !plain.errors.includes(e))]) errors.push(`journey: ${e}`);
  if (erased > 0 && (doc.erase ?? []).length === 0) errors.push("`erase` must list the steps that erase a persona when `erased` > 0");
  if (errors.length > 0) return { errors, simulation: null };
  const { errors: browserErrors, browser } = loadBrowser(doc.browser, plain.journey);
  if (browserErrors.length > 0) return { errors: browserErrors, simulation: null };
  // The erase steps alone, played with the journey's captures once the pages were opened.
  const erase = { ...erasing.journey, steps: erasing.journey.steps.slice(plain.journey.steps.length) };
  return {
    errors,
    simulation: {
      personas, erased, journey: plain.journey, erase, browser,
      ignore: [...(journeyDoc.ignore ?? []), ...(doc.ignore ?? [])],
      retention_columns: doc.retention_columns ?? null,
      back_date: doc.back_date ?? [],
    },
  };
}

// Playwright is only loaded for a front (a `browser` section), in the runner image of
// tests/gdpr/privacy/runner-image; the APIs and BFFs run on a plain node image.
async function launchChromium() {
  const { chromium } = await import("playwright");
  return chromium.launch();
}

export async function main(argv, { env = process.env, fetchImpl = fetch, log = console.log, launchBrowser = launchChromium, recordPage = null } = {}) {
  const [file, runDir] = argv;
  if (!file || !runDir) {
    console.error("usage: node simulation/simulate.mjs <gdpr-simulation.yaml> <run dir>");
    return 2;
  }
  const { errors, simulation } = loadSimulation(readFileSync(file, "utf8"), dirname(resolve(file)));
  if (errors.length > 0) {
    console.error(`${file} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    return 2;
  }
  try {
    assertTestStack([simulation.journey.target, ...(simulation.browser ? [simulation.browser.target] : [])], env);
  } catch (error) {
    console.error(error.message);
    return 3;
  }
  mkdirSync(runDir, { recursive: true });
  const personas = generatePersonas(simulation.personas, simulation.erased);
  if (simulation.journey.wait && !(await waitFor(`${simulation.journey.target}${simulation.journey.wait}`, { fetchImpl }))) {
    console.error(`${simulation.journey.target}${simulation.journey.wait} never answered`);
    return 1;
  }
  let browser = null;
  let privacy = null;
  const states = [];
  const consoleEntries = [];
  const storage = [];
  if (simulation.browser) {
    privacy = await import("../privacy/privacy.mjs");
    browser = await launchBrowser();
  }
  const journeys = [];
  try {
    for (const persona of personas) {
      const personaLog = (line) => log(`${persona.id} ${line}`);
      const played = await play(simulation.journey, { marker: persona.values, env, fetchImpl, log: personaLog });
      const results = [...played.results];
      const sensitive = { ...played.sensitive };
      const journeyOk = played.results.every((r) => r.ok);
      if (journeyOk && simulation.browser) {
        const context = { ...played.captures, marker: persona.values, env: Object.fromEntries(simulation.journey.env.map((n) => [n, env[n]])) };
        const seen = await browsePersona(simulation.browser, { browser, persona: persona.id, context, recordPage: recordPage ?? privacy.recordPage, log: personaLog });
        results.push(...seen.results);
        states.push(...seen.states);
        consoleEntries.push(...seen.console);
        storage.push(...seen.storage);
      }
      if (journeyOk && persona.erase) {
        const erased = await play(simulation.erase, { marker: persona.values, env, captures: played.captures, fetchImpl, log: personaLog });
        results.push(...erased.results);
        Object.assign(sensitive, erased.sensitive);
      }
      journeys.push({ persona: persona.id, erase: persona.erase, results, sensitive });
    }
  } finally {
    await browser?.close();
  }
  if (simulation.browser) {
    mkdirSync(join(runDir, "browser"), { recursive: true });
    writeFileSync(join(runDir, "browser", "console.json"), `${JSON.stringify(consoleEntries)}\n`);
    writeFileSync(join(runDir, "browser", "storage.json"), `${JSON.stringify(storage)}\n`);
    const findings = privacy.evaluatePrivacy(states, { target: simulation.browser.target, allowedOrigins: simulation.browser.allowedOrigins });
    writeFileSync(join(runDir, "browser", "privacy.json"), `${JSON.stringify(findings, null, 2)}\n`);
  }
  writeFileSync(join(runDir, "personas.json"), `${JSON.stringify({ personas, ignore: simulation.ignore }, null, 2)}\n`);
  writeFileSync(join(runDir, "journeys.json"), `${JSON.stringify(journeys.map(({ sensitive, ...rest }) => rest), null, 2)}\n`);
  // Tokens captured as sensitive are searched like the persona values.
  writeFileSync(join(runDir, "sensitive.json"), `${JSON.stringify(journeys.map((j) => ({ persona: j.persona, sensitive: j.sensitive })))}\n`);
  return journeys.every((j) => j.results.every((r) => r.ok)) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
