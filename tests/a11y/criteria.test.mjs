import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadCriteria } from "./criteria.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const axe = createRequire(import.meta.url)("axe-core");
const criteria = loadCriteria();
const checks = Object.values(criteria).flatMap((c) => c.checks);

test("criteria.yaml lists the 106 RGAA 4.1.2 criteria with the checklist levels", () => {
  assert.equal(Object.keys(criteria).length, 106);
  const levels = Object.values(criteria).reduce((n, c) => ({ ...n, [c.level]: (n[c.level] ?? 0) + 1 }), {});
  assert.deepEqual(levels, { auto: 10, semi: 34, manual: 62 });
});

test("every axe rule exists in the pinned axe-core", () => {
  const rules = new Set(axe.getRules().map((r) => r.ruleId));
  const unknown = checks.filter((c) => c.startsWith("axe:") && !rules.has(c.slice(4)));
  assert.deepEqual(unknown, []);
});

test("every scenario is implemented, and every implemented scenario is used", () => {
  const used = new Set(checks.filter((c) => c.startsWith("scenario:")).map((c) => c.slice(9)));
  assert.deepEqual([...used].filter((s) => !(s in SCENARIOS)), []);
  assert.deepEqual(Object.keys(SCENARIOS).filter((s) => !used.has(s)), []);
});

test("coverage is consistent with the checks", () => {
  for (const [id, c] of Object.entries(criteria)) {
    assert.ok(["full", "partial", "none"].includes(c.coverage), id);
    assert.equal(c.checks.length === 0, c.coverage === "none", `${id}: checks and coverage disagree`);
    assert.ok(checks.every((check) => /^(axe|scenario):[a-z0-9-]+$/.test(check)), id);
  }
});
