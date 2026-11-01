// Driver of the GDPR simulation (MAIR-497), the command of the `gdpr-simulation` runner of a repo's
// simulation stack. Refuses to run outside a test stack (guard.mjs), generates the personas, plays
// the repo's journey (the gdpr-marker.yaml format of MAIR-290) for each of them, then the `erase`
// steps for the personas to erase, and writes <run dir>/personas.json and journeys.json for
// analyze.mjs. The rest of the run (k6 over every operation, back-dated rows, purge, the fronts'
// states) is driven by the repo's script; see the CICD README.
//
// Usage: node simulation/simulate.mjs <gdpr-simulation.yaml> <run dir>
// Exit 0: every journey played. 1: a step failed. 2: invalid file. 3: not a test stack.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { loadJourney, play, waitFor } from "../marker/journey.mjs";
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
  for (const key of Object.keys(doc).filter((k) => !["version", "journey", "personas", "erased", "erase", "ignore", "retention_columns", "back_date"].includes(k))) errors.push(`unknown key \`${key}\``);
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
  return {
    errors,
    simulation: {
      personas, erased, journey: plain.journey, erasing: erasing.journey,
      ignore: [...(journeyDoc.ignore ?? []), ...(doc.ignore ?? [])],
      retention_columns: doc.retention_columns ?? null,
      back_date: doc.back_date ?? [],
    },
  };
}

export async function main(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
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
    assertTestStack([simulation.journey.target], env);
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
  const journeys = [];
  for (const persona of personas) {
    const journey = persona.erase ? simulation.erasing : simulation.journey;
    const { results, sensitive } = await play(journey, { marker: persona.values, env, fetchImpl, log: (line) => log(`${persona.id} ${line}`) });
    journeys.push({ persona: persona.id, erase: persona.erase, results, sensitive });
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
