import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONCURRENCY, mapLimit, parallelism } from "./run.mjs";

test("mapLimit keeps the order and never exceeds the limit", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running -= 1;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("the concurrency defaults to 4 and is bounded", () => {
  assert.equal(DEFAULT_CONCURRENCY, 4);
  assert.equal(parallelism({}), 4);
  assert.equal(parallelism({ RGAA_CONCURRENCY: "2" }), 2);
  assert.throws(() => parallelism({ RGAA_CONCURRENCY: "0" }), /between 1 and 16/);
  assert.throws(() => parallelism({ RGAA_CONCURRENCY: "x" }), /between 1 and 16/);
});
