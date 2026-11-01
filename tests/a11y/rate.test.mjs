import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MIN_RATE, computeRate, criterionStatus, minRate } from "./rate.mjs";

const criterion = (coverage, failures = 0, review = 0) => ({
  coverage,
  failures: Array.from({ length: failures }, () => ({})),
  review: Array.from({ length: review }, () => ({})),
});

test("a failure invalidates a criterion whatever its coverage", () => {
  for (const coverage of ["full", "partial", "none"]) assert.equal(criterionStatus(criterion(coverage, 1)), "invalidated");
});

test("only a full coverage without anything to review validates a criterion", () => {
  assert.equal(criterionStatus(criterion("full")), "validated");
  assert.equal(criterionStatus(criterion("full", 0, 1)), "to_review");
  assert.equal(criterionStatus(criterion("partial")), "to_review");
  assert.equal(criterionStatus(criterion("none")), "to_review");
});

test("the CI rate counts the decided criteria only", () => {
  const statuses = ["validated", "validated", "validated", "invalidated", "to_review", "to_review"];
  const rate = computeRate(statuses.map((status) => ({ status })), 60);
  assert.deepEqual(rate, { validated: 3, invalidated: 1, to_review: 2, value: 75, min: 60, passed: true });
  assert.equal(computeRate(statuses.map((status) => ({ status })), 80).passed, false);
});

test("rounds to one decimal and passes when nothing is decided", () => {
  assert.equal(computeRate([{ status: "validated" }, { status: "validated" }, { status: "invalidated" }], 60).value, 66.7);
  assert.deepEqual(computeRate([{ status: "to_review" }], 60), { validated: 0, invalidated: 0, to_review: 1, value: null, min: 60, passed: true });
});

test("the threshold defaults to 60 % and can be overridden", () => {
  assert.equal(DEFAULT_MIN_RATE, 60);
  assert.equal(minRate({}), 60);
  assert.equal(minRate({ RGAA_MIN_RATE: "" }), 60);
  assert.equal(minRate({ RGAA_MIN_RATE: "75" }), 75);
  assert.throws(() => minRate({ RGAA_MIN_RATE: "120" }), /between 0 and 100/);
  assert.throws(() => minRate({ RGAA_MIN_RATE: "abc" }), /between 0 and 100/);
});
