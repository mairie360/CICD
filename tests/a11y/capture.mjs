// Capture and checks of one reached state (MAIR-318): normalized HTML, accessibility tree and
// screenshots (the snapshot, fingerprinted), axe-core, the scenarios, and the elements that need
// a criterion the front did not declare.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DATA_TABLES, SCENARIOS } from "./scenarios.mjs";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const HELPERS_SOURCE = readFileSync(new URL("./page-helpers.js", import.meta.url), "utf8");

// Elements whose presence makes a criterion applicable: when the front's rgaa.yaml does not
// declare it, the run fails (MAIR-316).
export const PRESENCE = [
  { criterion: "1.1", selector: 'img, [role="img"], input[type="image"], area[href], object', what: "an image" },
  { criterion: "2.1", selector: "iframe, frame", what: "a frame" },
  { criterion: "4.1", selector: "video, audio", what: "a media element" },
  { criterion: "5.6", selector: DATA_TABLES, what: "a data table" },
  { criterion: "6.2", selector: "a[href]", what: "a link" },
  {
    criterion: "11.1",
    selector: 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"]',
    what: "a form field",
  },
];

export function axeRules(criteria) {
  return [...new Set(Object.values(criteria).flatMap((c) => c.checks).filter((c) => c.startsWith("axe:")).map((c) => c.slice(4)))];
}

export function fingerprint(html, aria) {
  return createHash("sha256").update(html).update("\n--aria--\n").update(aria).digest("hex");
}

async function runAxe(page, rules) {
  if (rules.length === 0) return {};
  await page.addScriptTag({ content: AXE_SOURCE });
  const result = await page.evaluate(
    (values) => window.axe.run(document, { runOnly: { type: "rule", values }, resultTypes: ["violations", "incomplete"] }),
    rules,
  );
  const toNodes = (item) => item.nodes.map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 300), message: n.failureSummary ?? item.help }));
  const checks = {};
  for (const rule of rules) checks[`axe:${rule}`] = { failures: [], review: [] };
  for (const v of result.violations) checks[`axe:${v.id}`].failures.push(...toNodes(v));
  for (const i of result.incomplete) checks[`axe:${i.id}`].review.push(...toNodes(i));
  return checks;
}

// `scope` is the validated rgaa.yaml, `criteria` the parsed criteria.yaml. Returns
// { fingerprint, files, checks, undeclared } and writes the snapshot under <dir>.
export async function captureState(page, { scope, criteria, dir }) {
  mkdirSync(dir, { recursive: true });
  await page.addScriptTag({ content: HELPERS_SOURCE });

  const html = await page.evaluate(() => window.__rgaa.normalizedHtml());
  const aria = await page.locator("body").ariaSnapshot();
  writeFileSync(join(dir, "page.html"), html);
  writeFileSync(join(dir, "aria.yml"), aria);
  await page.screenshot({ path: join(dir, "desktop.png"), fullPage: true });
  const files = { html: "page.html", aria: "aria.yml", screenshots: ["desktop.png"] };
  const screenshot = async (name) => {
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
    files.screenshots.push(`${name}.png`);
  };

  const declared = new Set(scope.criteria);
  const undeclared = await page.evaluate(
    (presence) =>
      presence.flatMap(({ criterion, selector, what }) => {
        const el = [...document.querySelectorAll(selector)].find((e) => window.__rgaa.visible(e) || e.localName === "a");
        return el ? [{ criterion, ...window.__rgaa.failure(el, `${what} is present but criterion ${criterion} is not declared in rgaa.yaml`) }] : [];
      }),
    PRESENCE.filter((p) => !declared.has(p.criterion)),
  );

  // Only the checks of the declared criteria run (hover-content alone hovers every control).
  const applicable = Object.fromEntries(scope.criteria.map((id) => [id, criteria[id]]));
  const checks = await runAxe(page, axeRules(applicable));
  const wanted = new Set(Object.values(applicable).flatMap((c) => c.checks).filter((c) => c.startsWith("scenario:")));
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    if (!wanted.has(`scenario:${id}`)) continue;
    try {
      // A scenario returns its failures, or { failures, review } when it also has items to review.
      const out = await scenario(page, { screenshot });
      checks[`scenario:${id}`] = Array.isArray(out) ? { failures: out, review: [] } : out;
    } catch (error) {
      // A scenario that cannot run is not a pass: its criteria go to review.
      checks[`scenario:${id}`] = { failures: [], review: [{ target: "", html: "", message: `scenario error: ${error.message.split("\n")[0]}` }] };
    }
  }
  if (!files.screenshots.includes("mobile-320.png")) await screenshot("mobile-320");

  return { fingerprint: fingerprint(html, aria), files, checks, undeclared };
}
