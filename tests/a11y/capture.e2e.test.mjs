// Capture and checks against pages with known defects (MAIR-318). Needs the browsers of the
// runner image: run with RGAA_E2E=1 inside it (see the a11y job of lint.yml).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureState } from "./capture.mjs";
import { loadCriteria } from "./criteria.mjs";
import { playState } from "./states.mjs";

const e2e = process.env.RGAA_E2E === "1";

const page = (lang, body, head = "") =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Projets - Mairie 360</title>${head}</head><body>${body}</body></html>`;

// Compliant page. The random id and the date written by the script change at every load:
// normalization and the fixed clock must keep the fingerprint stable.
const GOOD = page(
  "fr",
  `<a href="#main" class="skip">Aller au contenu</a>
  <header><nav aria-label="Principale"><ul><li><a href="/">Accueil</a></li></ul></nav></header>
  <main id="main"><h1>Projets</h1>
    <p id="today"></p>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo de la mairie" width="10" height="10">
    <button><svg aria-hidden="true" width="10" height="10"></svg>Créer</button>
    <label id="lbl">Nom</label><input aria-labelledby="lbl">
  </main>
  <footer><p>Mairie 360</p></footer>
  <script>
    const id = ":r" + Math.random().toString(36).slice(2) + ":";
    const label = document.getElementById("lbl");
    label.id = id;
    document.querySelector("input").setAttribute("aria-labelledby", id);
    document.getElementById("today").textContent = new Date().toISOString();
  </script>`,
  "<style>.skip{position:absolute;left:-999px}.skip:focus{left:0}a:focus,button:focus,input:focus{outline:3px solid #000}</style>",
);

const BAD = page(
  "en",
  `<main><h1>Projets</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">
    <svg width="10" height="10"><circle r="4"></circle></svg>
    <p id="dup">a</p><p id="dup">b</p>
    <div style="width:600px">Bloc trop large pour 320 px</div>
    <div style="width:120px;height:20px;overflow:hidden">Texte coupé quand on agrandit la police du document</div>
    <a href="/doc.pdf" target="_blank">Rapport</a>
    <button id="tip">Aide</button><div id="tipbox" hidden>Bulle</div>
    <button id="trap">Piège</button><button>Jamais atteint</button>
    <table><tr><th>Nom</th></tr><tr><td>A</td></tr></table>
  </main>
  <script>
    const tip = document.getElementById("tip"), box = document.getElementById("tipbox");
    tip.addEventListener("mouseenter", () => (box.hidden = false));
    tip.addEventListener("mouseleave", () => (box.hidden = true));
    document.getElementById("trap").addEventListener("keydown", (e) => { if (e.key === "Tab") e.preventDefault(); });
  </script>`,
  "<style>*:focus{outline:none}</style>",
);

// Three ways to show a message after a click: only the second one is announced.
const STATUS = page(
  "fr",
  `<main><h1>Projets</h1>
    <div role="status" id="live"></div>
    <button id="toast">Créer</button><button id="good">Enregistrer</button><button id="plain">Rechercher</button><button id="alert">Valider</button>
  </main>
  <script>
    document.getElementById("toast").onclick = () => {
      const toast = document.createElement("div");
      toast.setAttribute("role", "status");
      toast.textContent = "Projet créé";
      document.querySelector("main").append(toast);
      setTimeout(() => toast.remove(), 200);
    };
    document.getElementById("good").onclick = () => (document.getElementById("live").textContent = "Modifications enregistrées");
    document.getElementById("alert").onclick = () => {
      const alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.textContent = "Email ou mot de passe incorrect.";
      document.querySelector("main").append(alert);
    };
    document.getElementById("plain").onclick = () => {
      const p = document.createElement("p");
      p.textContent = "3 résultats";
      document.querySelector("main").append(p);
    };
  </script>`,
);

// An open modal that lets Tab out (7.1, not a 12.9 trap), a portrait lock (13.9) and a hidden table
// from the host page (Storybook's docs wrapper) that must be ignored.
const MODAL = page(
  "fr",
  `<div hidden class="sb-wrapper"><table><tr><td>docs</td></tr></table></div>
  <main><h1>Utilisateurs</h1><button>Derrière la modale</button>
    <div role="dialog" aria-modal="true" aria-label="Nouvel utilisateur">
      <button>Annuler</button><button>Créer</button>
    </div>
  </main>`,
  "<style>@media (orientation: portrait) { main { display: none; } } button:focus { outline: 3px solid #000; }</style>",
);

const AI_PAGE = page(
  "fr",
  `<main><h1>Projets</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=" alt="IMG_2041.png" width="40" height="40">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" width="10" height="10">
    <p>Le rapport annuel est disponible. <a href="/rapport.pdf">Cliquez ici</a></p>
    <label for="d">Date</label><input id="d" placeholder="jj/mm/aaaa">
    <label>Service <select><option>Direction générale</option><option>Ressources humaines</option></select></label>
    <button role="switch" aria-checked="false" aria-label="Mode maintenance"></button>
    <button aria-label="Supprimer le projet"><svg aria-hidden="true" width="8" height="8"></svg></button>
    <button aria-label="Sélectionner le 15 juin" style="display:flex;flex-direction:column"><span>Lun</span><span>15</span></button>
    <p>Projet terminé 🎉</p>
  </main>`,
);

let server;
let browser;
let criteria;
const target = () => `http://127.0.0.1:${server.address().port}`;

before(async () => {
  if (!e2e) return;
  server = createServer((request, response) => {
    const body = { "/good": GOOD, "/bad": BAD, "/status": STATUS, "/modal": MODAL, "/ai": AI_PAGE }[new URL(request.url, "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  criteria = loadCriteria();
});

after(async () => {
  await browser?.close();
  server?.close();
});

const ALL = ["1.1", "1.2", "6.2", "8.2", "8.3", "8.4", "8.5", "9.1", "10.4", "10.7", "10.11", "10.13", "11.1", "12.7", "12.9", "13.2"];

async function capture(route, declared = ALL, steps = [], ai = false) {
  const scope = { target: target(), criteria: declared, states: [] };
  let captured;
  const dir = mkdtempSync(join(tmpdir(), "rgaa-"));
  const result = await playState(browser, scope, { id: route.slice(1), route, steps }, {
    onReached: async (p) => (captured = await captureState(p, { scope, criteria, dir, stateId: route.slice(1), ai })),
  });
  assert.equal(result.reached, true, result.error);
  return { ...captured, dir };
}

const failing = (captured, criterion) =>
  criteria[criterion].checks.flatMap((check) => (captured.checks[check]?.failures ?? []).map((f) => ({ check, ...f })));

test("a compliant page has no failure and a stable fingerprint", { skip: !e2e }, async () => {
  const first = await capture("/good");
  for (const criterion of ALL) assert.deepEqual(failing(first, criterion), [], `criterion ${criterion}`);
  assert.deepEqual(first.undeclared, []);
  const second = await capture("/good");
  assert.equal(second.fingerprint, first.fingerprint, "normalized HTML or aria snapshot changed between runs");
  assert.ok(readFileSync(join(first.dir, "page.html"), "utf8").includes('aria-labelledby="gen-1"'));
  assert.deepEqual(first.files.screenshots, ["desktop.png", "mobile-320.png"]);
});

test("each seeded defect fails its criterion", { skip: !e2e }, async () => {
  const bad = await capture("/bad");
  const expected = {
    "1.1": "axe:image-alt",
    "1.2": "scenario:decorative-svg",
    "8.2": "scenario:duplicate-ids",
    "8.4": "scenario:lang-fr",
    "10.4": "scenario:zoom-200",
    "10.7": "scenario:focus-visible",
    "10.11": "scenario:reflow-320",
    "10.13": "scenario:hover-content",
    "12.7": "scenario:skip-link",
    "12.9": "scenario:keyboard",
    "13.2": "scenario:new-window",
  };
  for (const [criterion, check] of Object.entries(expected)) {
    assert.ok(failing(bad, criterion).some((f) => f.check === check), `${criterion} should fail through ${check}`);
  }
  assert.deepEqual(bad.undeclared.map((u) => u.criterion), ["5.6"]);
});

test("run.mjs writes the report and fails on undeclared criteria", { skip: !e2e }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rgaa-run-"));
  writeFileSync(
    join(dir, "rgaa.yaml"),
    `version: 1\ntarget: ${target()}\ncriteria: ["1.1", "8.3"]\nstates:\n  - id: good\n    route: /good\n`,
  );
  // Asynchronous: the page server runs in this process.
  let code = 0;
  try {
    await promisify(execFile)("node", [new URL("./run.mjs", import.meta.url).pathname, join(dir, "rgaa.yaml"), join(dir, "report")]);
  } catch (error) {
    code = error.code;
  }
  // /good has a link and a form field: 6.2 and 11.1 are not declared.
  assert.equal(code, 1);
  const report = JSON.parse(readFileSync(join(dir, "report", "report.json"), "utf8"));
  assert.deepEqual(report.criteria.map((c) => c.id), ["1.1", "8.3"]);
  assert.deepEqual(report.undeclared.map((u) => u.criterion).sort(), ["11.1", "6.2"]);
  assert.match(report.states[0].fingerprint, /^[0-9a-f]{64}$/);
  // Both declared criteria have full coverage and pass on /good.
  assert.deepEqual(report.rate, { validated: 2, invalidated: 0, to_review: 0, value: 100, min: 60, passed: true });
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /### Undeclared criteria/);
});

test("status messages: a region inserted with its text fails, a plain text goes to review", { skip: !e2e }, async () => {
  const captured = await capture("/status", ["7.5"], [
    { click: { role: "button", name: "Créer" } },
    { click: { role: "button", name: "Enregistrer" } },
    { click: { role: "button", name: "Rechercher" } },
    { wait_for: { text: "3 résultats" } },
    // An alert inserted with its text is announced (WAI-ARIA): neither a failure nor a review item.
    { click: { role: "button", name: "Valider" } },
    { wait_for: { text: "Email ou mot de passe incorrect." } },
  ]);
  const { failures, review } = captured.checks["scenario:status-messages"];
  // The toast removed itself before the capture: it is still reported.
  assert.deepEqual(failures.map((f) => f.message), [
    'live region inserted with its message, so it is not announced (after step 1): "Projet créé"',
  ]);
  assert.deepEqual(review.map((r) => r.message), [
    'text appeared after step 3 outside any live region (status message?): "3 résultats"',
  ]);
});

test("a modal that lets the focus out fails 7.1, not as a keyboard trap", { skip: !e2e }, async () => {
  const captured = await capture("/modal", ["5.4", "7.1", "12.9", "13.9"]);
  const ids = (criterion) => failing(captured, criterion).map((f) => f.check);
  assert.ok(ids("7.1").includes("scenario:modal-focus"), "modal-focus should fail");
  assert.deepEqual(ids("12.9"), [], "leaving the modal is not a keyboard trap");
  assert.deepEqual(ids("5.4"), [], "the hidden table must be ignored");
  assert.ok(ids("13.9").includes("scenario:orientation"), "portrait lock should fail 13.9");
});

async function runEngine(scopeYaml, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rgaa-run-"));
  writeFileSync(join(dir, "rgaa.yaml"), scopeYaml);
  let code = 0;
  try {
    await promisify(execFile)("node", [new URL("./run.mjs", import.meta.url).pathname, join(dir, "rgaa.yaml"), join(dir, "report")], {
      env: { ...process.env, ...env },
    });
  } catch (error) {
    code = error.code;
  }
  const reportFile = join(dir, "report", "report.json");
  return { code, report: JSON.parse(readFileSync(reportFile, "utf8")) };
}

test("the rate gate fails the run below the minimum", { skip: !e2e }, async () => {
  // On /bad: 1.1 fails (image without alt); 6.2, 8.3 and 8.5 pass with full coverage; 5.6 has a
  // partial coverage and goes to review. CI rate = 3 / 4 = 75 %.
  const scopeYaml = `version: 1\ntarget: ${target()}\ncriteria: ["1.1", "5.6", "6.2", "8.3", "8.5"]\nstates:\n  - id: bad\n    route: /bad\n`;
  const passing = await runEngine(scopeYaml);
  assert.equal(passing.code, 0);
  assert.deepEqual(passing.report.rate, { validated: 3, invalidated: 1, to_review: 1, value: 75, min: 60, passed: true });
  assert.deepEqual(
    Object.fromEntries(passing.report.criteria.map((c) => [c.id, c.status])),
    { "1.1": "invalidated", "5.6": "to_review", "6.2": "validated", "8.3": "validated", "8.5": "validated" },
  );
  const failing = await runEngine(scopeYaml, { RGAA_MIN_RATE: "80" });
  assert.equal(failing.code, 3);
  assert.equal(failing.report.rate.passed, false);
});

test("extracts the elements of the AI criteria, with a screenshot for images", { skip: !e2e }, async () => {
  const declared = ["1.1", "1.3", "6.1", "6.2", "11.1", "11.2", "11.9", "13.5"];
  const { aiItems } = await capture("/ai", declared, [], true);
  const of = (criterion) => aiItems.filter((i) => i.criterion === criterion);
  assert.deepEqual(of("1.3").map((i) => i.name), ["IMG_2041.png"], "decorative images (alt empty) are left to 1.2");
  assert.ok(of("1.3")[0].image?.length > 0, "a screenshot of the image is attached");
  assert.deepEqual(of("6.1").map((i) => i.name), ["Cliquez ici"]);
  assert.match(of("6.1")[0].context, /rapport annuel/);
  assert.deepEqual(of("11.2").map((i) => [i.name, i.placeholder]), [["Date", "jj/mm/aaaa"], ["Service", ""], ["Mode maintenance", ""]]);
  assert.deepEqual(of("11.9").map((i) => i.name), ["Mode maintenance", "Supprimer le projet", "Sélectionner le 15 juin"]);
  assert.match(of("11.9")[2].visible_text, /^Lun\s+15$/, "rendered text keeps the separation between blocks");
  assert.ok(aiItems.every((i) => !i.html.includes("data-rgaa-ai")), "the extraction marker never reaches the html");
  assert.deepEqual(of("13.5").map((i) => i.text), ["Projet terminé 🎉"]);
  const again = await capture("/ai", declared, [], true);
  assert.deepEqual(again.aiItems.map((i) => i.fingerprint), aiItems.map((i) => i.fingerprint), "stable fingerprints");
});
