import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposalsYaml, propose } from "./ai.mjs";
import { main } from "./check.mjs";
import { compare, diff, parseInventory } from "./inventory.mjs";

const INVENTORY = `version: 1
tables:
  users:
    audited: true
    personal:
      id: {category: identifier, erasure: keep, visibility: directory}
      email: {category: contact, erasure: anonymize, visibility: directory}
      password: {category: credentials, erasure: anonymize, visibility: internal, audit_log: false}
  roles:
    not_personal: [id, name]
  user_roles:
    personal:
      user_id: {category: identifier, erasure: delete, visibility: directory}
    not_personal: [role_id]
`;

const col = (table_name, column_name, refers_to = null) => ({ table_name, column_name, type: "integer", nullable: false, comment: null, refers_to });
const SCHEMA = [
  col("users", "id"), col("users", "email"), col("users", "password"),
  col("roles", "id"), col("roles", "name"),
  col("user_roles", "user_id", "users"), col("user_roles", "role_id", "roles"),
];

test("a complete inventory has no gap", () => {
  const { errors, entries } = parseInventory(INVENTORY);
  assert.deepEqual(errors, []);
  assert.equal(entries.size, 7);
  assert.deepEqual(compare(entries, SCHEMA), { missing: [], stale: [], notIdentifier: [] });
});

test("missing columns, stale entries and references to users that are not identifiers are gaps", () => {
  const { entries } = parseInventory(INVENTORY.replace("not_personal: [role_id]", "not_personal: [role_id, ghost]"));
  const schema = [...SCHEMA, col("users", "phone"), col("roles", "created_by", "users")];
  const { missing, stale, notIdentifier } = compare(entries, schema);
  assert.deepEqual(missing.map((c) => `${c.table_name}.${c.column_name}`), ["users.phone", "roles.created_by"]);
  assert.deepEqual(stale, ["user_roles.ghost"]);
  assert.deepEqual(notIdentifier, []);

  const wrong = parseInventory(INVENTORY.replace("user_id: {category: identifier", "user_id: {category: activity")).entries;
  assert.deepEqual(compare(wrong, SCHEMA).notIdentifier, ["user_roles.user_id"]);
});

test("the format errors are readable", () => {
  const bad = INVENTORY
    .replace("category: contact", "category: contacts")
    .replace("roles:\n    not_personal: [id, name]", "roles:\n    personal:\n      id: {category: identity, erasure: keep, visibility: directory, audit_log: false}\n    not_personal: [id, name, name]");
  const { errors } = parseInventory(bad);
  assert.ok(errors.includes("users.email: category must be one of identifier, identity, contact, credentials, connection, account, activity, content, preferences"));
  assert.ok(errors.includes("roles.id: audit_log only applies to an audited table"));
  assert.ok(errors.includes("roles.id: listed both as personal and not personal"));
  assert.ok(errors.includes("roles.name: listed twice"));
  assert.deepEqual(parseInventory("tables: {}").errors, ["the file must be a mapping with `version: 1`"]);
  assert.match(parseInventory("version: [").errors[0], /^not valid YAML/);
});

test("the diff lists added, changed and removed entries", () => {
  const before = parseInventory(INVENTORY).entries;
  const after = parseInventory(
    INVENTORY.replace("email: {category: contact, erasure: anonymize, visibility: directory}", "email: {category: contact, erasure: anonymize, visibility: admin, note: decided with the DPO}")
      .replace("not_personal: [id, name]", "not_personal: [id, name, description]")
      .replace("\n      password: {category: credentials, erasure: anonymize, visibility: internal, audit_log: false}", ""),
  ).entries;
  const { added, removed, changed } = diff(before, after);
  assert.deepEqual(added.map((e) => `${e.table}.${e.column}`), ["roles.description"]);
  assert.deepEqual(removed, ["users.password"]);
  assert.deepEqual(changed, [{ name: "users.email", fields: [{ field: "visibility", from: "directory", to: "admin" }, { field: "note", from: null, to: "decided with the DPO" }] }]);
});

// A fake client: answers the proposals of the columns it receives, records the requests.
function fakeClient(answer) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        parse: async (request) => {
          requests.push(request);
          const columns = JSON.parse(request.messages[0].content);
          return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, parsed_output: { proposals: columns.map(answer) } };
        },
      },
    },
  };
}

test("the AI proposes an entry per missing column, as inventory YAML", async () => {
  const client = fakeClient(({ id, column }) =>
    column === "phone"
      ? { id, personal: true, category: "contact", erasure: "anonymize", visibility: "directory", note: "phone of the agent" }
      : { id, personal: false, category: null, erasure: null, visibility: null, note: "creation date of a role" });
  const missing = [col("users", "phone"), col("roles", "created_at")];
  const { proposals, usage, error } = await propose(missing, { client, model: "claude-sonnet-5-5", inventoryText: INVENTORY });
  assert.equal(error, null);
  assert.equal(usage.input_tokens, 10);
  assert.equal(proposals.length, 2);
  const request = client.requests[0];
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.match(request.system[1].text, /Current inventory:\nversion: 1/);
  assert.deepEqual(request.system[1].cache_control, { type: "ephemeral" });
  assert.equal(
    proposalsYaml(proposals, "claude-sonnet-5-5"),
    [
      "# Proposed by claude-sonnet-5-5: review each entry before adding it to gdpr/inventory.yaml.",
      "  roles:",
      "    # created_at: creation date of a role",
      "    not_personal: [created_at]",
      "  users:",
      "    personal:",
      '      phone: {category: contact, erasure: anonymize, visibility: directory, note: "phone of the agent"}',
      "",
    ].join("\n"),
  );
});

test("check.mjs blocks on a gap, reports the changes and the AI proposals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-"));
  const write = (name, content) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  const previous = write("previous.yaml", INVENTORY.replace("not_personal: [id, name]", "not_personal: [id]"));
  const inventory = write("inventory.yaml", INVENTORY);
  const report = join(dir, "report");

  // Complete: exit 0, the diff names the column added since the previous release.
  const complete = write("schema.json", JSON.stringify(SCHEMA));
  assert.equal(await main([inventory, complete, report, previous, "v1.0.0"], {}), 0);
  const ok = readFileSync(join(report, "summary.md"), "utf8");
  assert.match(ok, /✅ Every column of the schema is classified/);
  assert.match(ok, /### Changes since `v1.0.0`/);
  assert.match(ok, /\| `roles.name` \| added: not personal \|/);

  // A new column: exit 1 and a proposal, whatever the AI says.
  const client = fakeClient(({ id }) => ({ id, personal: true, category: "contact", erasure: "anonymize", visibility: "directory", note: "phone" }));
  const gap = write("schema-gap.json", JSON.stringify([...SCHEMA, col("users", "phone")]));
  assert.equal(await main([inventory, gap, report], { ANTHROPIC_API_KEY: "test" }, () => client), 1);
  const blocked = readFileSync(join(report, "summary.md"), "utf8");
  assert.match(blocked, /❌ The inventory does not match the schema/);
  assert.match(blocked, /- `users.phone` \(integer\)/);
  assert.match(blocked, /phone: \{category: contact/);
  assert.match(blocked, /No previous release carries an inventory/);
  assert.match(readFileSync(join(report, "proposals.yaml"), "utf8"), /users:/);

  // Without a key: still exit 1, the summary says why there is no proposal.
  assert.equal(await main([inventory, gap, report], {}), 1);
  assert.match(readFileSync(join(report, "summary.md"), "utf8"), /No proposal: no ANTHROPIC_API_KEY/);

  // Invalid inventory: exit 2.
  const invalid = write("invalid.yaml", INVENTORY.replace("category: contact", "category: phone"));
  assert.equal(await main([invalid, complete, report], {}), 2);
});

test("the redis section declares every key prefix with its maximum TTL (MAIR-499)", () => {
  const withRedis = `${INVENTORY}redis:
  "revoked:": {personal: false, max_ttl_seconds: 3600, note: "revocation list of the sessions"}
  "core-api:forgot_password_token": {personal: true, category: credentials, max_ttl_seconds: 900}
`;
  const { errors, redis } = parseInventory(withRedis);
  assert.deepEqual(errors, []);
  assert.deepEqual(redis.get("core-api:forgot_password_token"), { personal: true, category: "credentials", max_ttl_seconds: 900 });
  const bad = parseInventory(`${INVENTORY}redis:
  "a:": {personal: true, max_ttl_seconds: 0}
  "b:": {personal: false, category: identity, max_ttl_seconds: 10, ttl: 3}
`).errors;
  assert.deepEqual(bad, [
    "redis a:: category must be one of identifier, identity, contact, credentials, connection, account, activity, content, preferences",
    "redis a:: max_ttl_seconds must be a whole number of seconds (every Redis key expires)",
    "redis b:: unknown key `ttl`",
    "redis b:: category only applies to a personal prefix",
  ]);
  assert.equal(parseInventory(INVENTORY).redis.size, 0, "the section is optional");
});
