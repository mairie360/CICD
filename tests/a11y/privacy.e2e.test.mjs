// Records the requests, cookies and legal links of a state in a real browser (MAIR-292). Needs the
// browsers of the runner image: run with RGAA_E2E=1 inside it (see the a11y job of lint.yml).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { evaluatePrivacy } from "./privacy.mjs";
import { playState } from "./states.mjs";

const e2e = process.env.RGAA_E2E === "1";

let front;
let other;
let browser;
let scope;

before(async () => {
  if (!e2e) return;
  // A second origin, standing for a third party (font, tracker).
  other = createServer((_, response) => response.writeHead(200, { "content-type": "text/css" }).end("body{}"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const thirdParty = `http://localhost:${other.address().port}`;
  front = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/login") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["accessToken=x; Path=/; HttpOnly; SameSite=Strict", "tracker=1; Path=/"],
      });
      response.end(`<!doctype html><html lang="fr"><title>t</title><link rel="stylesheet" href="${thirdParty}/font.css">
        <body><main><h1>Connexion</h1></main><footer><a href="/mentions-legales">Mentions légales</a></footer>
        <script>document.cookie = "theme=dark; path=/";</script></body></html>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="fr"><title>t</title><body><main><h1>Accueil</h1></main>
      <footer><a href="/mentions-legales">Mentions légales</a> <a href="/confidentialite">Politique de confidentialité</a></footer></body></html>`);
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  scope = {
    target: `http://127.0.0.1:${front.address().port}`,
    session: { jwt_secret: 'b"secret"', jwt_timeout: 3600, cookie: "accessToken" },
    users: { agent: { id: 2, role: "user" } },
  };
});

after(async () => {
  await browser?.close();
  front?.close();
  other?.close();
});

test("records the requests, the cookies and the legal links of each state", { skip: !e2e }, async () => {
  const login = await playState(browser, scope, { id: "login", route: "/login" }, { privacy: true });
  const home = await playState(browser, scope, { id: "home", route: "/", as: "agent" }, { privacy: true });
  assert.ok(login.reached && home.reached);
  assert.deepEqual(home.privacy.js_cookies, [], "the session the engine injects is not the front's");
  const result = evaluatePrivacy(
    [{ id: "login", story: false, privacy: login.privacy }, { id: "home", story: false, privacy: home.privacy }],
    { target: scope.target },
  );
  assert.deepEqual(result.third_party.map((t) => [t.types, t.states]), [[["stylesheet"], ["login"]]]);
  assert.deepEqual(
    result.cookies.map((c) => [c.name, c.via, c.problems]),
    [
      ["accessToken", "Set-Cookie", ["not Secure"]],
      ["tracker", "Set-Cookie", ["not a session cookie", "not HttpOnly", "not Secure", "no SameSite"]],
      ["theme", "document.cookie", ["not a session cookie", "not HttpOnly", "not Secure"]],
    ],
  );
  assert.deepEqual(result.legal_missing, [{ state: "login", missing: ["privacy policy"] }]);
});
