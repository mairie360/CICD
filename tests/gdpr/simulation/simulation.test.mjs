import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseInventory } from "../inventory.mjs";
import { parseAccepted } from "./accepted.mjs";
import { review } from "./ai.mjs";
import { main as analyzeMain } from "./analyze.mjs";
import { contentSampleSql, erasureSql, retentionSql } from "./db.mjs";
import { assertTestStack, isStackHost } from "./guard.mjs";
import { generatePersonas } from "./personas.mjs";
import { main as simulateMain } from "./simulate.mjs";
import { groupTemplates, templateOf } from "./templates.mjs";

let seed = 0;
const random = (n) => (seed = (seed * 31 + 7) % 9973) % n;

test("the simulation refuses to run outside a test stack", () => {
  assert.ok(isStackHost("core") && isStackHost("localhost") && isStackHost("172.18.0.4") && isStackHost("api.test"));
  assert.ok(!isStackHost("core.mairie360.fr") && !isStackHost("8.8.8.8"));
  assert.throws(() => assertTestStack(["http://core:3000"], {}), /GDPR_SIMULATION=test-stack is not set/);
  assert.throws(() => assertTestStack(["https://core.mairie360.fr"], { GDPR_SIMULATION: "test-stack" }), /not a host of a test stack/);
  assert.doesNotThrow(() => assertTestStack(["http://core:3000"], { GDPR_SIMULATION: "test-stack" }));
});

test("log lines are grouped into stable templates", () => {
  assert.equal(templateOf("2026-10-08T11:32:56.364Z WARN user 42 session 2f9a1c74-5b3e-4d21-9c8a-7e6f0b1d4a35 from 172.18.0.6 in 12ms"),
    "<date> WARN user <n> session <uuid> from <ip> in <n>");
  assert.equal(templateOf('{"password": "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"}'), '{"password": "<hash>"}', "salted hashes do not change the template");
  const groups = groupTemplates([
    { service: "core-1", text: "GET /users/1 200" },
    { service: "core-1", text: "GET /users/2 200" },
    { service: "bff", text: "GET /users/2 200" },
  ]);
  assert.deepEqual(groups.map((g) => [g.service, g.count]), [["bff", 1], ["core", 2]]);
  assert.equal(groupTemplates([{ service: "core-1", text: "GET /users/9 200" }])[0].fingerprint, groups[1].fingerprint, "same template, same fingerprint");
});

test("accepted risks need a fingerprint, a reason, a date and an author", () => {
  assert.equal(parseAccepted("version: 1\nrisks:\n  - {fingerprint: 0123456789abcdef01234567, reason: ok, date: 2026-10-08, author: Quentin}\n").accepted.size, 1);
  assert.deepEqual(parseAccepted("version: 1\nrisks:\n  - {fingerprint: x, reason: '', date: yesterday}\n").errors, [
    "risks[0]: fingerprint must be the 24 hex characters of the report",
    "risks[0]: reason is required",
    "risks[0]: date must be YYYY-MM-DD",
    "risks[0]: author is required",
  ]);
});

test("the database checks skip the kept columns and the password", () => {
  const { entries } = parseInventory(`version: 1
tables:
  users:
    personal:
      id: {category: identifier, erasure: keep, visibility: directory}
      email: {category: contact, erasure: anonymize, visibility: directory}
      password: {category: credentials, erasure: anonymize, visibility: internal}
  access_logs:
    personal:
      reason: {category: activity, erasure: keep, visibility: internal}
  messages:
    personal:
      content: {category: content, erasure: anonymize, visibility: members}
`);
  const schema = [
    { table_name: "users", column_name: "id", type: "integer" },
    { table_name: "users", column_name: "email", type: "character varying(320)" },
    { table_name: "users", column_name: "password", type: "text" },
    { table_name: "access_logs", column_name: "reason", type: "text" },
    { table_name: "messages", column_name: "content", type: "text" },
  ];
  seed = 1;
  const personas = generatePersonas(2, 1, random);
  const sql = erasureSql(entries, schema, personas);
  assert.match(sql, /FROM "users" WHERE "email"::text ILIKE/);
  assert.match(sql, /FROM "messages" WHERE "content"::text ILIKE/);
  assert.doesNotMatch(sql, /access_logs|"password"|'p1'/, "kept columns, hashes and the personas that stay are not probed");
  assert.match(retentionSql({ sessions: "created_at" }), /x\."created_at" < now\(\) - p\.retention_period/);
  assert.match(contentSampleSql(entries, schema), /FROM "messages"/);
});

function writeRun(dir, personas, { log, console = [], storage = [], erasure = [] }) {
  mkdirSync(join(dir, "browser"), { recursive: true });
  mkdirSync(join(dir, "db"), { recursive: true });
  writeFileSync(join(dir, "personas.json"), JSON.stringify({ personas, ignore: [{ service: "mailpit", reason: "SMTP sink" }] }));
  writeFileSync(join(dir, "containers.log"), log);
  writeFileSync(join(dir, "browser", "console.json"), JSON.stringify(console));
  writeFileSync(join(dir, "browser", "storage.json"), JSON.stringify(storage));
  writeFileSync(join(dir, "db", "erasure.sql.json"), JSON.stringify(erasure));
  writeFileSync(join(dir, "db", "retention.sql.json"), "[]");
  writeFileSync(join(dir, "db", "content.sql.json"), "[]");
}

test("a leak in a log, the console or the storage blocks; erasure is an expected failure", async () => {
  seed = 2;
  const personas = generatePersonas(2, 1, random);
  const email = personas[0].values.email;
  const dir = mkdtempSync(join(tmpdir(), "gdpr-sim-"));
  const env = { GDPR_AI: "off" };
  const log = () => {};
  writeRun(dir, personas, { log: `core-1  | GET /users/1 200\nmailpit-1  | mail for ${email}\n`, erasure: [{ table_name: "messages", column_name: "content", persona: "p2", field: "email", rows: 1 }] });
  assert.equal(await analyzeMain([dir, join(dir, "report")], { env, log }), 0, "mailpit is ignored, the erasure gap is expected");
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /expected failures until MAIR-289/);
  assert.equal(await analyzeMain([dir, join(dir, "report")], { env: { ...env, GDPR_SIMULATION_ERASURE: "enforce" }, log }), 1);

  for (const leak of [
    { log: `core-1  | login failed for ${email}\n` },
    { log: "core-1  | ok\n", console: [{ state: "login", type: "log", text: `user ${email}` }] },
    { log: "core-1  | ok\n", storage: [{ state: "profile", area: "local", key: "user", value: JSON.stringify({ email }) }] },
  ]) {
    writeRun(dir, personas, leak);
    assert.equal(await analyzeMain([dir, join(dir, "report")], { env, log }), 1);
    const report = JSON.parse(readFileSync(join(dir, "report", "report.json"), "utf8"));
    assert.equal(report.deterministic[0].persona, "p1");
    assert.doesNotMatch(JSON.stringify(report), new RegExp(email.replace(".", "\\.")), "the report masks the values");
  }
});

test("a high AI risk blocks unless accepted, and the cache gives the same verdicts", async () => {
  seed = 3;
  const personas = generatePersonas(1, 0, random);
  const dir = mkdtempSync(join(tmpdir(), "gdpr-sim-ai-"));
  writeRun(dir, personas, { log: "core-1  | request body {\"note\":\"x\"}\ncore-1  | GET /health 200\n" });
  let calls = 0;
  const client = {
    beta: { messages: { parse: async (request) => {
      calls += 1;
      const items = JSON.parse(request.messages[0].content);
      return { stop_reason: "end_turn", usage: {}, parsed_output: { verdicts: items.map((i) => ({ id: i.id, risk: i.text.includes("body") ? "high" : "none", justification: "fixture" })) } };
    } } },
  };
  const env = { ANTHROPIC_API_KEY: "test", GDPR_AI_CACHE: join(dir, "cache.json") };
  assert.equal(await analyzeMain([dir, join(dir, "report")], { env, client, log: () => {} }), 1);
  const high = JSON.parse(readFileSync(join(dir, "report", "report.json"), "utf8")).findings.find((f) => f.risk === "high");
  assert.equal(await analyzeMain([dir, join(dir, "report2")], { env, client, log: () => {} }), 1);
  assert.equal(calls, 1, "the second run is answered from the cache");
  writeFileSync(join(dir, "accepted.yaml"), `version: 1\nrisks:\n  - {fingerprint: ${high.fingerprint}, reason: fixture body, date: 2026-10-08, author: test}\n`);
  assert.equal(await analyzeMain([dir, join(dir, "report3"), join(dir, "accepted.yaml")], { env, client, log: () => {} }), 0);
  const cache = { version: 1, answers: {} };
  const first = await review([{ fingerprint: "a", kind: "log", where: "x", text: "body" }], { client, model: "m", cache });
  assert.equal(first.verdicts.get("a").risk, "high");
});

test("the driver plays the journey per persona and the erase steps for the erased ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-sim-run-"));
  writeFileSync(join(dir, "journey.yaml"), `version: 1
target: http://api:3000
steps:
  - name: create
    request: {method: POST, path: /users, json: {email: "{{marker.email}}"}}
    capture: {id: body.id}
`);
  writeFileSync(join(dir, "sim.yaml"), `version: 1
journey: journey.yaml
personas: 3
erased: 1
erase:
  - name: erase
    request: {method: DELETE, path: "/users/{{id}}"}
`);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ id: calls.length }), { status: 200 });
  };
  assert.equal(await simulateMain([join(dir, "sim.yaml"), join(dir, "run")], { env: {}, fetchImpl, log: () => {} }), 3, "refused without GDPR_SIMULATION");
  assert.equal(await simulateMain([join(dir, "sim.yaml"), join(dir, "run")], { env: { GDPR_SIMULATION: "test-stack" }, fetchImpl, log: () => {} }), 0);
  assert.deepEqual(calls, ["POST /users", "POST /users", "POST /users", "DELETE /users/3"]);
  const { personas } = JSON.parse(readFileSync(join(dir, "run", "personas.json"), "utf8"));
  assert.deepEqual(personas.map((p) => p.erase), [false, false, true]);
});

test("every Redis key expires within its declared prefix", async () => {
  const { checkRedis, parseKeys, prefixPattern } = await import("./redis.mjs");
  assert.ok(prefixPattern("core-api:{user_id}/first_connection_token").test("core-api:42/first_connection_token"));
  assert.ok(!prefixPattern("core-api:{user_id}/first_connection_token").test("core-api:42/x/first_connection_token"));
  const prefixes = { "revoked:{session_id}": { max_ttl_seconds: 3600 }, "core-api:{token}/first_connection_id": { max_ttl_seconds: 86400 } };
  const keys = parseKeys("revoked:abc\t3500\nrevoked:def\t-1\ncore-api:t1/first_connection_id\t90000\ncache:users:7\t60\ngone:x\t-2\n");
  assert.deepEqual(checkRedis(keys, prefixes).map((f) => [f.where, f.excerpt]), [
    ["revoked:{session_id}", "key without TTL"],
    ["core-api:{token}/first_connection_id", "TTL 90000 s above the declared maximum of 86400 s"],
    ["cache:…", "key prefix not declared in the inventory (redis section)"],
  ]);
});

// One OTLP JSON export request, as the collector's `file` exporter writes it (MAIR-501).
function otlpLine(service, name, attributes) {
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [{ spans: [{ name, attributes: Object.entries(attributes).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } })) }] }],
    }],
  });
}

test("traces and the usage ledger carry actions only (MAIR-501)", async () => {
  seed = 3;
  const personas = generatePersonas(2, 1, random);
  const email = personas[0].values.email;
  const env = { GDPR_AI: "off" };
  const log = () => {};
  const clean = otlpLine("core-api", "GET /api/v1/user/me", { "http.request.method": "GET", "http.route": "/api/v1/user/me", "http.response.status_code": 200, "url.full": "http://core:3000/api/v1/user/me" });
  const ledger = [{ service: "core-api", operation: "GET /api/v1/user/me", period: "2026-10-09T10", actions: 42, distinct_users: 7 }];

  const dir = mkdtempSync(join(tmpdir(), "gdpr-sim-traces-"));
  writeRun(dir, personas, { log: "core-1  | ok\n" });
  assert.equal(await analyzeMain([dir, join(dir, "report")], { env, log }), 0);
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /Not checked: traces, usage ledger/);

  writeFileSync(join(dir, "traces.jsonl"), `${clean}\n`);
  writeFileSync(join(dir, "usage.json"), JSON.stringify(ledger));
  assert.equal(await analyzeMain([dir, join(dir, "report")], { env, log }), 0, "actions only: nothing blocks");
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /1 spans/);

  for (const [label, traces, usage, check] of [
    ["persona value in a span", otlpLine("core-api", "POST /login", { "app.login": email }), ledger, "trace"],
    ["user id attribute", otlpLine("core-api", "GET /me", { "enduser.id": 12 }), ledger, "trace attribute"],
    ["query string", otlpLine("bff-user", "GET /search", { "url.full": `http://core:3000/api/v1/user?search=${encodeURIComponent("Dupont")}` }), ledger, "trace attribute"],
    ["persona value in the ledger", clean, [{ ...ledger[0], operation: `GET /user?email=${email}` }], "usage"],
    ["person key in the ledger", clean, [{ ...ledger[0], user_id: 12 }], "usage field"],
  ]) {
    writeFileSync(join(dir, "traces.jsonl"), `${traces}\n`);
    writeFileSync(join(dir, "usage.json"), JSON.stringify(usage));
    assert.equal(await analyzeMain([dir, join(dir, "report")], { env, log }), 1, label);
    const report = JSON.parse(readFileSync(join(dir, "report", "report.json"), "utf8"));
    assert.ok(report.deterministic.some((d) => d.check === check), `${label}: ${JSON.stringify(report.deterministic)}`);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(email.replace(/[.+]/g, "\\$&")), `${label}: the value is masked in the report`);
  }
});
