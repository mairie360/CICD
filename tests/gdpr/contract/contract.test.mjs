import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseInventory } from "../inventory.mjs";
import { fingerprint, loadCache, proposeMappings } from "./ai.mjs";
import { main } from "./check.mjs";
import { check, parseDecisions, responseFields } from "./contract.mjs";

const INVENTORY = `version: 1
tables:
  users:
    audited: true
    personal:
      id: {category: identifier, erasure: keep, visibility: directory}
      email: {category: contact, erasure: anonymize, visibility: directory}
      password: {category: credentials, erasure: anonymize, visibility: internal, audit_log: false}
  sessions:
    personal:
      user_id: {category: identifier, erasure: delete, visibility: self}
      token_hash: {category: credentials, erasure: delete, visibility: internal}
    not_personal: [id]
`;
const { entries } = parseInventory(INVENTORY);

const SPEC = {
  openapi: "3.1.0",
  paths: {
    "/users/{id}": {
      get: {
        responses: {
          200: { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
          404: { content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },
    "/sessions": {
      get: {
        responses: {
          200: { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Session" } } } } },
        },
      },
    },
    "/auth/login": {
      post: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Login" } } } } } },
    },
  },
  components: {
    schemas: {
      // Recursive on purpose: the walk must stop.
      User: { type: "object", properties: { id: { type: "integer" }, email: { type: "string" }, password: { type: "string" }, manager: { $ref: "#/components/schemas/User" } } },
      Session: { allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: "object", properties: { token: { type: "string" }, device: { type: "string" } } }] },
      Login: { type: "object", properties: { refresh_token: { type: "string" } } },
    },
  },
};

test("response fields are found through $ref, allOf, arrays and recursion", () => {
  const fields = responseFields(SPEC);
  const pointers = fields.map((f) => `${f.operation} ${f.pointer}`);
  assert.ok(pointers.includes("GET /users/{id} password"));
  assert.ok(pointers.includes("GET /users/{id} manager"));
  assert.ok(pointers.includes("GET /sessions [].token"));
  assert.ok(!pointers.some((p) => p.includes("manager.manager")), "the recursion stops");
  assert.equal(fields.find((f) => f.field === "token").schema, "Session");
});

test("a credentials column in a response fails, unless allowed with a reason", () => {
  const fields = responseFields(SPEC);
  const { decisions } = parseDecisions(null, entries);
  const result = check(fields, entries, decisions);
  assert.deepEqual(result.violations.map((v) => [v.operation, v.pointer, v.columns]), [["GET /users/{id}", "password", ["users.password"]]]);
  assert.deepEqual(result.personal.find((p) => p.operation === "GET /users/{id}").columns, ["users.email", "users.password"]);
  assert.deepEqual(result.unmapped.map((u) => u.field), ["device", "manager", "refresh_token", "token"]);

  const text = `version: 1
fields:
  token: sessions.token_hash
allow:
  - operation: GET /sessions
    field: token
    reason: test fixture
  - operation: GET /nothing
    field: password
    reason: stale
`;
  const parsed = parseDecisions(text, entries);
  assert.deepEqual(parsed.errors, []);
  const mapped = check(fields, entries, parsed.decisions);
  assert.deepEqual(mapped.allowed.map((a) => [a.operation, a.field, a.reason]), [["GET /sessions", "token", "test fixture"]]);
  assert.equal(mapped.violations.length, 1, "the password of /users/{id} still fails");
  assert.deepEqual(mapped.staleAllows.map((a) => a.operation), ["GET /nothing"]);
});

test("the decision file is validated with readable errors", () => {
  const { errors } = parseDecisions(`version: 1
fields:
  token: sessions.secret
  mail: email
allow:
  - operation: users
    field: password
  - {operation: GET /users, field: password, reason: ok}
extra: 1
`, entries);
  assert.deepEqual(errors, [
    "unknown key `extra`",
    "fields.token: sessions.secret is not a column of the inventory",
    "fields.mail: must name a column as table.column",
    'allow[0]: must be { operation: "METHOD /path", field, reason }',
  ]);
});

test("AI proposals are cached by fingerprint and never invent a column", async () => {
  let calls = 0;
  const client = {
    beta: {
      messages: {
        parse: async (request) => {
          calls += 1;
          const items = JSON.parse(request.messages[0].content);
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
            parsed_output: {
              answers: items.map((i) => ({
                id: i.id,
                column: i.field === "token" ? "sessions.token_hash" : i.field === "device" ? "sessions.device" : null,
                reason: "fixture",
              })),
            },
          };
        },
      },
    },
  };
  const unmapped = [{ field: "token", schemas: ["Session"] }, { field: "device", schemas: ["Session"] }, { field: "manager", schemas: ["User"] }];
  const cache = { version: 1, answers: {} };
  const first = await proposeMappings(unmapped, { client, model: "m", inventoryText: INVENTORY, entries, cache });
  assert.deepEqual(first.proposals.map((p) => [p.field, p.column]), [["token", "sessions.token_hash"]], "sessions.device is not in the inventory");
  assert.equal(first.asked, 3);
  const second = await proposeMappings(unmapped, { client, model: "m", inventoryText: INVENTORY, entries, cache });
  assert.equal(calls, 1, "the second run is answered from the cache");
  assert.equal(second.cached, 3);
  assert.notEqual(fingerprint("m", unmapped[0]), fingerprint("other", unmapped[0]), "a new model asks again");
  assert.deepEqual(loadCache(join(tmpdir(), "no-such-cache.json")), { version: 1, answers: {} });
});

test("the CLI exits 1 on a violation, 2 on an invalid decision file, and writes the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-contract-"));
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(SPEC));
  writeFileSync(join(dir, "inventory.yaml"), INVENTORY);
  const env = { GDPR_AI: "off" };
  const log = () => {};
  assert.equal(await main([join(dir, "openapi.json"), join(dir, "inventory.yaml"), join(dir, "report")], { env, log }), 1);
  const summary = readFileSync(join(dir, "report", "summary.md"), "utf8");
  assert.match(summary, /❌ A response carries a credentials column/);
  assert.match(summary, /`GET \/users\/\{id\}` \| 200 \| `password` \| `users.password`/);
  writeFileSync(join(dir, "gdpr-contract.yaml"), "version: 1\nallow:\n  - {operation: \"GET /users/{id}\", field: password, reason: fixture}\n");
  assert.equal(await main([join(dir, "openapi.json"), join(dir, "inventory.yaml"), join(dir, "report"), join(dir, "gdpr-contract.yaml")], { env, log }), 0);
  writeFileSync(join(dir, "bad.yaml"), "version: 2\n");
  assert.equal(await main([join(dir, "openapi.json"), join(dir, "inventory.yaml"), join(dir, "report"), join(dir, "bad.yaml")], { env, log }), 2);
});
