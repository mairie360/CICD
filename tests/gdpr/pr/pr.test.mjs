import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewableDiff, reviewPullRequest, warning } from "./ai.mjs";
import { clientOptions, main, REVIEW_DEADLINE_MS } from "./check.mjs";
import { parseAnswer, verdict } from "./checklist.mjs";

// The section of the organization PR template (mairie360/.github), as an author fills it.
const body = (no, yes, inventory = "") => `## What
Something.

## Personal data
<!-- GDPR (MAIR-295): tick one. -->
- [${no ? "x" : " "}] No: this PR does not add, change, expose, log, send or delete personal data.
- [${yes ? "x" : " "}] Yes: it does.
  Inventory: ${inventory}<!-- link to the Database PR, or why it does not change -->

## Tests
- [x] Yes, tested
`;

test("the answer is read from the Personal data section only", () => {
  assert.deepEqual(parseAnswer(body(true, false)), { answer: "no", inventory: null, errors: [] });
  assert.deepEqual(parseAnswer(body(false, true, "mairie360/Database#170")), { answer: "yes", inventory: "mairie360/Database#170", errors: [] });
  assert.deepEqual(parseAnswer(body(false, false)).errors, ['tick "No" or "Yes" in the "Personal data" section']);
  assert.deepEqual(parseAnswer(body(true, true)).errors, ['tick only one of "No" and "Yes" in the "Personal data" section']);
  assert.match(parseAnswer("## What\n- [x] Yes\n").errors[0], /no "Personal data" section/);
  assert.equal(parseAnswer(body(false, true, "<link>")).inventory, null, "a placeholder is no answer");
});

test("Yes needs the inventory change in Database, or a reference elsewhere", () => {
  const yes = parseAnswer(body(false, true));
  assert.equal(verdict(yes, { changedFiles: ["src/a.rs"], inventoryPath: null }).ok, false);
  assert.equal(verdict(parseAnswer(body(false, true, "column unchanged, only a log removed")), { changedFiles: [], inventoryPath: null }).ok, true);
  assert.equal(verdict(yes, { changedFiles: ["gdpr/inventory.yaml"], inventoryPath: "gdpr/inventory.yaml" }).ok, true);
  assert.equal(verdict(yes, { changedFiles: ["liquibase/x.sql"], inventoryPath: "gdpr/inventory.yaml" }).ok, false);
  assert.equal(verdict(parseAnswer(body(true, false)), { changedFiles: [], inventoryPath: null }).ok, true);
});

test("lock files are left out of the reviewed diff, a cached review is reused", async () => {
  const diff = "diff --git a/package-lock.json b/package-lock.json\n+x\ndiff --git a/src/a.ts b/src/a.ts\n+console.log(user.email)\n";
  assert.equal(reviewableDiff(diff).text, "diff --git a/src/a.ts b/src/a.ts\n+console.log(user.email)\n");
  let calls = 0;
  const client = {
    beta: { messages: { parse: async () => {
      calls += 1;
      return { stop_reason: "end_turn", parsed_output: { touches_personal_data: true, confidence: "high", inventory_change_needed: false, findings: [{ file: "src/a.ts", reason: "logs an e-mail" }] } };
    } } },
  };
  const cache = { version: 1, answers: {} };
  const first = await reviewPullRequest({ client, model: "m", inventoryText: "", diff, answer: "no", cache });
  const second = await reviewPullRequest({ client, model: "m", inventoryText: "", diff, answer: "no", cache });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.match(warning("no", first.review, { inventoryChanged: false }), /marked "No personal data"/);
  assert.equal(warning("yes", first.review, { inventoryChanged: false }), null);
  assert.equal(warning("no", { ...first.review, touches_personal_data: false }, { inventoryChanged: false }), null);
});

test("the CLI exits 1 on a missing answer and writes the summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-pr-"));
  for (const [name, text] of [["body.md", body(false, false)], ["changed.txt", "src/a.rs\n"], ["diff.patch", ""], ["inventory.yaml", "version: 1\n"]]) writeFileSync(join(dir, name), text);
  const args = ["body.md", "changed.txt", "diff.patch", "inventory.yaml"].map((f) => join(dir, f));
  assert.equal(await main([...args, join(dir, "report")], { env: { GDPR_AI: "off" }, log: () => {} }), 1);
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /Personal data: \*\*not answered\*\*/);
  writeFileSync(join(dir, "body.md"), body(true, false));
  assert.equal(await main([...args, join(dir, "report")], { env: { GDPR_AI: "off" }, log: () => {} }), 0);
});

test("the AI client is bounded under the job's 10 minutes", () => {
  const options = clientOptions({ ANTHROPIC_API_KEY: "k", ANTHROPIC_WORKSPACE_ID: "ws" });
  // maxRetries counts the retries after the first request: two attempts in all.
  assert.equal(options.maxRetries + 1, 2);
  assert.ok(options.timeout > 0 && options.timeout * (options.maxRetries + 1) < 10 * 60_000);
  assert.ok(REVIEW_DEADLINE_MS < 10 * 60_000);
  assert.deepEqual(options.defaultHeaders, { "anthropic-workspace-id": "ws" });
});

test("without ANTHROPIC_API_KEY (fork pull request) the skipped review is annotated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-pr-"));
  for (const [name, text] of [["body.md", body(true, false)], ["changed.txt", "src/a.rs\n"], ["diff.patch", ""], ["inventory.yaml", "version: 1\n"]]) writeFileSync(join(dir, name), text);
  const args = ["body.md", "changed.txt", "diff.patch", "inventory.yaml"].map((f) => join(dir, f));
  const notes = [];
  assert.equal(await main([...args, join(dir, "report")], { env: {}, log: () => {}, annotate: (l) => notes.push(l) }), 0);
  assert.ok(notes.some((l) => l.startsWith("::notice") && /no ANTHROPIC_API_KEY/.test(l)));
});

test("a review that never ends is cancelled by the deadline and does not decide the check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdpr-pr-"));
  for (const [name, text] of [["body.md", body(true, false)], ["changed.txt", "src/a.rs\n"], ["diff.patch", "diff --git a/src/a.rs b/src/a.rs\n+let x = 1;\n"], ["inventory.yaml", "version: 1\n"]]) writeFileSync(join(dir, name), text);
  const args = ["body.md", "changed.txt", "diff.patch", "inventory.yaml"].map((f) => join(dir, f));
  // A response whose body never ends: only the request's signal can stop it.
  const hanging = { beta: { messages: { parse: (_params, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal.reason));
  }) } } };
  const started = Date.now();
  const code = await main([...args, join(dir, "report")], { env: { ANTHROPIC_API_KEY: "k" }, client: hanging, log: () => {}, annotate: () => {}, deadlineMs: 200 });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5_000);
  assert.match(readFileSync(join(dir, "report", "summary.md"), "utf8"), /No review: the review took too long and was cancelled/);
});
