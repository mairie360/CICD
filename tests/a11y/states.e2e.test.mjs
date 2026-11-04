// Plays states against a local server in a real browser. Needs the browsers of the runner
// image: run with RGAA_E2E=1 inside it (see the a11y job of lint.yml).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { playState } from "./states.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const e2e = process.env.RGAA_E2E === "1";
const SECRET = 'b"secret"';

const PAGES = {
  "/": `<main><h1>Projets</h1>
    <button onclick="document.querySelector('dialog').showModal()">Nouveau projet</button>
    <dialog><form method="dialog"><label for="n">Nom du projet</label><input id="n">
      <label for="s">Statut</label><select id="s"><option>Ouvert</option><option>Clos</option></select>
      <button>Créer</button></form></dialog>
    <div role="combobox" aria-expanded="false" tabindex="0" aria-label="Priorité"
      onclick="this.nextElementSibling.hidden=false">Priorité</div>
    <ul role="listbox" hidden><li role="option" onclick="document.title=this.textContent">Haute</li></ul>
  </main>`,
  "/iframe.html": `<button>Bouton de story</button>`,
  // A menu button shown only on a narrow screen, like a mobile navigation drawer.
  "/mobile": `<style>#menu{display:none}@media (max-width:600px){#menu{display:block}}</style>
    <main><h1>Accueil</h1><button id="menu" onclick="document.querySelector('nav').hidden=false">Ouvrir la navigation</button>
    <nav hidden><a href="/">Tableau de bord</a></nav></main>`,
  // A drawer that a landscape window closes (orientation change), and one that any resize closes.
  "/drawer": `<main><h1>Accueil</h1><button onclick="document.querySelector('[role=dialog]').hidden=false">Ouvrir</button>
    <div role="dialog" aria-label="Navigation mobile" hidden><a href="/">Tableau de bord</a></div></main>
    <script>matchMedia("(orientation: landscape)").addEventListener("change", (e) => { if (e.matches) document.querySelector("[role=dialog]").hidden = true; });</script>`,
  "/fragile": `<main><h1>Accueil</h1><button onclick="document.querySelector('[role=dialog]').hidden=false">Ouvrir</button>
    <div role="dialog" aria-label="Navigation mobile" hidden><a href="/">Tableau de bord</a></div></main>
    <script>addEventListener("resize", () => { document.querySelector("[role=dialog]").hidden = true; });</script>`,
  // Reads a never-ending stream with fetch(), like the messaging front: the network never idles.
  "/live": `<main><h1>Messagerie</h1><p>Conversations</p></main>
    <script>fetch("/stream").then((response) => { const reader = response.body.getReader(); const pump = () => reader.read().then(({ done }) => done || pump()); pump(); });</script>`,
};

let server;
const streams = new Set();
let browser;
let scope;

before(async () => {
  if (!e2e) return;
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/stream") {
      // Answered, then held open: a fetch() that reads it keeps a request in flight for as long as
      // the page lives.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("data: ready\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (url.pathname === "/private" && !(request.headers.cookie ?? "").includes("accessToken=")) {
      response.writeHead(401).end("no session");
      return;
    }
    const broken = url.pathname === "/iframe.html" && url.searchParams.get("id") === "components-broken--default";
    const body = broken
      ? `<script>document.addEventListener("DOMContentLoaded", () => document.body.classList.add("sb-show-errordisplay"))</script><div id="error-message"><h1>React is not defined</h1></div>`
      : url.pathname === "/private" ? "<h1>Profil</h1>" : PAGES[url.pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ? `<!doctype html><html lang="fr"><title>t</title><body>${body}</body></html>` : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  scope = {
    target: `http://127.0.0.1:${server.address().port}`,
    session: { jwt_secret: SECRET, jwt_timeout: 3600, cookie: "accessToken" },
    users: { agent: { id: 2, role: "user" } },
  };
});

after(async () => {
  for (const stream of streams) stream.end();
  await browser?.close();
  server?.close();
});

test("plays the steps of a state", { skip: !e2e }, async () => {
  let title;
  const result = await playState(
    browser,
    scope,
    {
      id: "create",
      route: "/",
      steps: [
        { click: { role: "button", name: "Nouveau projet" } },
        { wait_for: { role: "dialog" } },
        { fill: { label: "Nom du projet", value: "École" } },
        { select: { label: "Statut", value: "Clos" } },
        { press: "Escape" },
        { wait_for_hidden: { role: "dialog" } },
        { select: { role: "combobox", name: "Priorité", value: "Haute" } },
      ],
    },
    { onReached: async (page) => (title = await page.title()) },
  );
  assert.equal(result.reached, true, result.error);
  assert.equal(title, "Haute");
});

test("opens the session of the state's user", { skip: !e2e }, async () => {
  const anonymous = await playState(browser, scope, { id: "anonymous", route: "/private" });
  assert.equal(anonymous.reached, false);
  assert.match(anonymous.error, /HTTP 401/);
  const logged = await playState(browser, scope, { id: "logged", route: "/private", as: "agent" });
  assert.equal(logged.reached, true, logged.error);
});

test("reports the failing step", { skip: !e2e }, async () => {
  const result = await playState(browser, scope, {
    id: "missing",
    route: "/",
    steps: [{ click: { role: "button", name: "Nouveau projet" } }, { click: { role: "button", name: "Supprimer" } }],
  });
  assert.equal(result.reached, false);
  assert.equal(result.failed_step, 1);
});

test("loads a Storybook story", { skip: !e2e }, async () => {
  const result = await playState(browser, scope, {
    id: "story",
    story: "components-button--primary",
    steps: [{ wait_for: { role: "button", name: "Bouton de story" } }],
  });
  assert.equal(result.reached, true, result.error);
});

test("a story that renders Storybook's error page is not reached", { skip: !e2e }, async () => {
  const result = await playState(browser, scope, { id: "broken", story: "components-broken--default" });
  assert.equal(result.reached, false);
  assert.match(result.error, /did not render: React is not defined/);
});

test("MAIR-318: a page that keeps a stream open is still reached", { skip: !e2e }, async () => {
  const result = await playState(browser, scope, {
    id: "live",
    route: "/live",
    steps: [{ wait_for: { text: "Conversations" } }],
  });
  assert.equal(result.reached, true, result.error);
});

test("MAIR-318: a state plays in its own viewport", { skip: !e2e }, async () => {
  const state = {
    id: "mobile",
    route: "/mobile",
    steps: [{ click: { role: "button", name: "Ouvrir la navigation" } }, { wait_for: { role: "link", name: "Tableau de bord" } }],
  };
  const desktop = await playState(browser, scope, state);
  assert.equal(desktop.reached, false, "the menu button is hidden on a desktop window");
  let width;
  const mobile = await playState(browser, scope, { ...state, viewport: { width: 375, height: 812 } }, {
    onReached: async (page) => { width = page.viewportSize().width; },
  });
  assert.equal(mobile.reached, true, mobile.error);
  assert.equal(width, 375);
});

test("MAIR-318: the 320 px reflow check keeps a portrait state and reports one it changed", { skip: !e2e }, async () => {
  const helpers = readFileSync(new URL("./page-helpers.js", import.meta.url), "utf8");
  const reflow = async (route) => {
    let outcome;
    const result = await playState(browser, scope, {
      id: route.slice(1),
      route,
      viewport: { width: 375, height: 812 },
      steps: [{ click: { role: "button", name: "Ouvrir" } }, { wait_for: { role: "link", name: "Tableau de bord" } }],
    }, {
      onReached: async (page) => {
        await page.addScriptTag({ content: helpers });
        const checked = await SCENARIOS["reflow-320"](page, {});
        outcome = { checked, open: await page.locator("[role=dialog]").isVisible(), width: page.viewportSize().width };
      },
    });
    assert.equal(result.reached, true, result.error);
    return outcome;
  };
  // Portrait kept at 320 px: the drawer survives, nothing to review, back to 375.
  const kept = await reflow("/drawer");
  assert.equal(kept.open, true);
  assert.ok(Array.isArray(kept.checked), "no review when the state is unchanged");
  assert.equal(kept.width, 375);
  // A page closing its drawer on any resize: the change is reported for review.
  const changed = await reflow("/fragile");
  assert.equal(changed.open, false);
  assert.match(changed.checked.review[0].message, /changed the state/);
});
