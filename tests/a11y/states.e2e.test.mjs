// Plays states against a local server in a real browser. Needs the browsers of the runner
// image: run with RGAA_E2E=1 inside it (see the a11y job of lint.yml).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { playState } from "./states.mjs";

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
};

let server;
let browser;
let scope;

before(async () => {
  if (!e2e) return;
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
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
