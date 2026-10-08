import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadJourney, play, render, usedFields } from "./journey.mjs";
import { generateMarker, needles } from "./marker.mjs";
import { main as run } from "./run.mjs";
import { main as scanMain, parseLogs, scan, serviceMatches } from "./scan.mjs";

const JOURNEY = `version: 1
target: http://api:3000
wait: /health
env: [ADMIN_JWT]
ignore:
  - service: mailpit
    reason: the SMTP sink receives the marker's e-mails by design
steps:
  - name: register
    request:
      method: post
      path: /register
      json: {email: "{{marker.email}}", password: "{{marker.password}}", first_name: "{{marker.first_name}}", last_name: "{{marker.last_name}}", phone: "{{marker.phone}}"}
    expect: 201
    capture:
      user_id: body.id
  - name: register twice (deliberate error)
    request: {method: POST, path: /register, json: {email: "{{marker.email}}", password: "{{marker.password}}"}}
    expect: [409]
  - name: login
    request: {method: POST, path: /login, json: {email: "{{marker.email}}", password: "{{marker.password}}"}}
    capture:
      token: {from: cookie.accessToken, sensitive: true}
  - name: read the profile
    request: {method: GET, path: "/users/{{user_id}}", headers: {Authorization: "Bearer {{token}}", X-Admin: "{{env.ADMIN_JWT}}"}}
`;

test("the marker values are unique and pass the usual validations", () => {
  const a = generateMarker();
  const b = generateMarker();
  assert.notEqual(a.email, b.email);
  assert.match(a.email, /^gdpr\.[a-z]{10}@example\.com$/);
  assert.match(a.first_name, /^Marker[a-z]{8}$/);
  assert.match(a.phone, /^06\d{8}$/);
  assert.match(a.password, /[a-z]/);
  assert.match(a.password, /[A-Z]/);
  assert.match(a.password, /\d/);
  assert.match(a.password, /[^a-zA-Z\d]/);
});

test("needles cover the encodings of a value and the stored phone number", () => {
  const marker = { email: "gdpr.abcdefghij@example.com", phone: "0612345678" };
  const list = needles(marker, { token: "tok.en+/=", authorization: "Bearer eyJhbGciOi.payload.sig" });
  const texts = (field) => list.filter((n) => n.field === field).map((n) => n.text);
  assert.ok(texts("email").includes("gdpr.abcdefghij%40example.com"));
  assert.ok(texts("phone").includes("612345678"));
  assert.ok(texts("token").includes("tok.en%2B%2F%3D"));
  assert.ok(texts("authorization").includes("eyJhbGciOi.payload.sig"), "the credential of a captured header alone");
  // Whatever its alignment inside a longer string, the base64 form is found.
  for (const prefix of ["", "a", "ab", '{"sub":"1","email":"']) {
    const encoded = Buffer.from(`${prefix}${marker.email}"}`).toString("base64");
    assert.ok(texts("email").some((t) => encoded.includes(t)), `base64 after ${JSON.stringify(prefix)}`);
  }
});

test("a journey file is validated with readable errors", () => {
  const { errors, journey } = loadJourney(JOURNEY);
  assert.deepEqual(errors, []);
  assert.equal(journey.steps[0].request.method, "POST");
  assert.deepEqual(journey.steps[0].expect, [201]);
  assert.deepEqual(journey.steps[2].capture.token, { from: "cookie.accessToken", sensitive: true });
  assert.deepEqual(usedFields(journey), ["email", "first_name", "last_name", "phone", "password"]);

  const bad = loadJourney(
    JOURNEY.replace("path: /register\n", "path: register\n")
      .replace("{{user_id}}", "{{userid}}")
      .replace("    reason: the SMTP sink receives the marker's e-mails by design\n", "")
      .replace("from: cookie.accessToken", "from: query.token"),
  );
  assert.deepEqual(bad.errors, [
    "`ignore` must list { service, reason }: a service whose logs may hold the marker, and why",
    "step 1 (register): path must start with /",
    "step 3 (login): capture token must come from body.<path>, header.<name> or cookie.<name>",
    "step 4 (read the profile): unknown placeholder {{userid}} (marker.<field>, env.<NAME> listed in env, or a capture of an earlier step)",
    // The invalid capture is not declared, so its later use is reported too.
    "step 4 (read the profile): unknown placeholder {{token}} (marker.<field>, env.<NAME> listed in env, or a capture of an earlier step)",
  ]);
  assert.deepEqual(loadJourney("version: 2").errors, ["the file must be a mapping with `version: 1`"]);
});

test("placeholders are rendered in nested values", () => {
  assert.deepEqual(render({ a: ["{{marker.email}}", 3], b: "x{{id}}y" }, { marker: { email: "e@x.fr" }, id: 7 }), { a: ["e@x.fr", 3], b: "x7y" });
  assert.throws(() => render("{{missing}}", {}), /\{\{missing\}\} has no value/);
});

test("compose log lines are attributed to their service", () => {
  const lines = parseLogs("core-1  | started\nmairie360-mailpit  | mail to x\nno prefix\n");
  assert.deepEqual(lines.map((l) => l.service), ["core-1", "mairie360-mailpit", "?"]);
  assert.equal(parseLogs("core-1  | \u001b[3merror\u001b[0m\u001b[2m=\u001b[0mbad")[0].text, "error=bad", "colour codes removed");
  assert.ok(serviceMatches("mailpit-1", "mailpit"));
  assert.ok(!serviceMatches("mailpit-ui-1", "mailpit"));
});

test("the scan masks the values, skips the runner and the ignored services", () => {
  const marker = { email: "gdpr.abcdefghij@example.com", password: "Mkabcdef!1234WXYZ" };
  const logs = parseLogs(
    [
      "core-1  | ERROR duplicate key: Key (email)=(GDPR.ABCDEFGHIJ@example.com) already exists",
      "core-1  | login failed for gdpr.abcdefghij%40example.com with Mkabcdef!1234WXYZ",
      "gdpr-marker-1  | ok register gdpr.abcdefghij@example.com",
      "mailpit-1  | accepted mail for gdpr.abcdefghij@example.com",
      "core-1  | GET /health 200",
    ].join("\n"),
  );
  const { findings, ignored } = scan(logs, needles(marker), [{ service: "mailpit", reason: "SMTP sink" }]);
  assert.deepEqual(findings.map((f) => [f.line, f.field, f.variant]), [[1, "email", "raw"], [2, "email", "url-encoded"], [2, "password", "raw"]]);
  assert.equal(findings[0].excerpt, "ERROR duplicate key: Key (email)=(<email>) already exists");
  assert.equal(findings[1].excerpt, "login failed for <email> with <password>");
  assert.deepEqual(Object.fromEntries(ignored), { mailpit: 1 });
});

// A fake service under test, with its "container log". `leaky` logs what a careless API logs.
async function startService({ leaky }) {
  const log = [];
  const users = new Map();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const reply = (status, payload, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      log.push(`${req.method} ${req.url}`);
      if (req.url === "/health") return reply(200, {});
      if (req.url === "/register") {
        if (users.has(body.email)) {
          log.push(leaky ? `conflict: ${body.email} already exists` : "conflict: e-mail already used");
          return reply(409, { error: "conflict" });
        }
        users.set(body.email, { id: users.size + 1, ...body });
        return reply(201, { id: users.size });
      }
      if (req.url === "/login") return reply(200, {}, { "set-cookie": "accessToken=secret-token-123; HttpOnly; Path=/" });
      if (req.url.startsWith("/users/")) {
        if (leaky) log.push(`auth header ${req.headers.authorization}`);
        return reply(200, { id: 1 });
      }
      return reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, log, target: `http://127.0.0.1:${server.address().port}` };
}

async function runAgainst(service) {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-marker-"));
  const journeyFile = join(dir, "gdpr-marker.yaml");
  writeFileSync(journeyFile, JOURNEY.replace("http://api:3000", service.target));
  const report = join(dir, "report");
  const played = await run([journeyFile, report], { env: { ADMIN_JWT: "admin.jwt.value" }, log: () => {} });
  writeFileSync(join(report, "containers.log"), service.log.map((line) => `api-1  | ${line}`).join("\n"));
  const code = scanMain([report]);
  return { played, code, summary: readFileSync(join(report, "summary.md"), "utf8"), report: JSON.parse(readFileSync(join(report, "report.json"), "utf8")) };
}

test("end to end: a clean service passes, a leaky one is caught", async () => {
  const clean = await startService({ leaky: false });
  try {
    const result = await runAgainst(clean);
    assert.equal(result.played, 0);
    assert.equal(result.code, 0);
    assert.match(result.summary, /✅ None of the marker's values appear/);
    assert.equal(result.report.journey.results.length, 4);
  } finally {
    clean.server.close();
  }

  const leaky = await startService({ leaky: true });
  try {
    const result = await runAgainst(leaky);
    assert.equal(result.code, 1);
    assert.deepEqual(result.report.findings.map((f) => f.field), ["email", "token"]);
    assert.match(result.summary, /`api-1`: 2 line\(s\) \(email, token\)/);
    assert.match(result.summary, /`auth header Bearer <token>`/);
    assert.doesNotMatch(result.summary, /secret-token-123/);
  } finally {
    leaky.server.close();
  }
});

test("a failed step stops the journey and fails the test", async () => {
  const service = await startService({ leaky: false });
  try {
    const { journey } = loadJourney(JOURNEY.replace("http://api:3000", service.target).replace("expect: [409]", "expect: [400]"));
    const { results } = await play(journey, { marker: generateMarker(), env: { ADMIN_JWT: "x" } });
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
    assert.equal(results[1].error, "answered 409, expected 400");
  } finally {
    service.server.close();
  }
});
