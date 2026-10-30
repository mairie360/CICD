// Records requests, cookies, legal links, console and storage of real pages (MAIR-292). Needs a
// browser: run with GDPR_E2E=1 inside the Playwright image (see the gdpr job of lint.yml).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { evaluatePrivacy, recordPage } from "./privacy.mjs";

const e2e = process.env.GDPR_E2E === "1";

let front;
let other;
let browser;
let target;

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
        <script>document.cookie = "theme=dark; path=/"; console.log("login page"); localStorage.setItem("draft", "hello");</script></body></html>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="fr"><title>t</title><body><main><h1>Accueil</h1></main>
      <footer><a href="/mentions-legales">Mentions légales</a> <a href="/confidentialite">Politique de confidentialité</a></footer></body></html>`);
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${front.address().port}`;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  front?.close();
  other?.close();
});

test("records the requests, cookies, legal links, console and storage of each page", { skip: !e2e }, async () => {
  const login = await recordPage(browser, `${target}/login`);
  const home = await recordPage(browser, `${target}/`, { cookies: [{ name: "accessToken", value: "jwt", url: target, httpOnly: true, sameSite: "Strict" }] });
  assert.equal(login.status, 200);
  assert.deepEqual(home.js_cookies, [], "the session the driver injects is not the front's");
  assert.ok(login.console.some((m) => m.type === "log" && m.text === "login page"), "the console is recorded");
  assert.deepEqual(login.storage, [{ area: "local", key: "draft", value: "hello" }], "the storage is dumped");
  const result = evaluatePrivacy(
    [{ id: "login", story: false, privacy: login }, { id: "home", story: false, privacy: home }],
    { target },
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
