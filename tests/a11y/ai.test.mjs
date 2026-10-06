import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, aiSettings, createClient, elements, estimatedRate, judge, proposals } from "./ai.mjs";
import { itemFingerprint } from "./extract.mjs";

const item = (criterion, name, extra = {}) => {
  const base = { kind: "x", index: 0, target: `#${name}`, html: `<a>${name}</a>`, context: "", name, ...extra };
  return { ...base, criterion, state: "s1", fingerprint: itemFingerprint(criterion, base) };
};

// Fake client: every element whose name contains "ici" is invalid; records the requests.
function fakeClient({ fail } = {}) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        parse: async (params) => {
          requests.push(params);
          if (fail) throw fail;
          const elements = JSON.parse(params.messages[0].content[0].text);
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            parsed_output: {
              verdicts: elements.map((e) => ({ id: e.id, verdict: /ici/.test(e.name) ? "invalid" : "valid", reason: "r" })),
            },
          };
        },
      },
    },
  };
}

test("settings: Sonnet 5.5 by default, configurable, off without a key", () => {
  assert.equal(DEFAULT_MODEL, "claude-sonnet-5-5");
  assert.deepEqual(aiSettings({ ANTHROPIC_API_KEY: "k" }).model, "claude-sonnet-5-5");
  assert.equal(aiSettings({ ANTHROPIC_API_KEY: "k", RGAA_AI_MODEL: "claude-opus-5-5" }).model, "claude-opus-5-5");
  assert.deepEqual(aiSettings({}).enabled, false);
  assert.equal(aiSettings({ ANTHROPIC_API_KEY: "k", RGAA_AI: "off" }).enabled, false);
});

test("requests: one per criterion batch, cached system prompt, structured output, images attached", async () => {
  const client = fakeClient();
  const items = [
    ...Array.from({ length: 16 }, (_, i) => item("6.1", `Lien ${i}`)),
    item("1.3", "Logo de la mairie", { image: "iVBORw0KGgo=" }),
  ];
  await judge(items, { client, model: "claude-sonnet-5-5", cache: { version: 1, verdicts: {} } });
  assert.equal(client.requests.length, 3, "6.1 in two batches of at most 15, 1.3 in one");
  const [first] = client.requests;
  assert.equal(first.model, "claude-sonnet-5-5");
  assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" });
  assert.equal(first.output_config.effort, "low");
  assert.ok(first.output_config.format, "structured output format");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  const imageRequest = client.requests.find((r) => r.messages[0].content.some((b) => b.type === "image"));
  assert.ok(imageRequest, "the 1.3 screenshot is sent as an image block");
  const sent = JSON.parse(imageRequest.messages[0].content[0].text)[0];
  assert.equal(sent.image, undefined, "the screenshot is not repeated in the JSON");
  assert.equal(sent.fingerprint, undefined);
});

test("no fallback parameter for models that do not accept it", async () => {
  const client = fakeClient();
  await judge([item("6.1", "Accueil")], { client, model: "claude-haiku-4-5", cache: { version: 1, verdicts: {} } });
  assert.equal(client.requests[0].fallbacks, undefined);
  assert.equal(client.requests[0].betas, undefined);
});

test("cache: an unchanged element is never sent twice, duplicates across states are judged once", async () => {
  const cache = { version: 1, verdicts: {} };
  const items = [item("6.1", "Accueil"), { ...item("6.1", "Accueil"), state: "s2" }, item("6.1", "Cliquez ici")];
  const client = fakeClient();
  const first = await judge(items, { client, model: "claude-sonnet-5-5", cache });
  assert.deepEqual([first.stats.elements, first.stats.judged, first.stats.cached], [2, 2, 0]);
  const again = fakeClient();
  const second = await judge(items, { client: again, model: "claude-sonnet-5-5", cache });
  assert.equal(again.requests.length, 0, "a run without change sends nothing to the AI");
  assert.deepEqual([second.stats.judged, second.stats.cached], [0, 2]);
});

test("an API error on some batches makes those elements uncertain, not cached", async () => {
  const cache = { version: 1, verdicts: {} };
  const error = new Anthropic.InternalServerError(500, { error: { message: "boom" } }, "boom", new Headers());
  const ok = fakeClient();
  let calls = 0;
  const flaky = { beta: { messages: { parse: async (p) => (calls++ === 0 ? Promise.reject(error) : ok.beta.messages.parse(p)) } } };
  const items = [...Array.from({ length: 15 }, (_, i) => item("6.1", `Lien ${i}`)), item("11.2", "Nom")];
  const { verdicts, stats } = await judge(items, { client: flaky, model: "claude-sonnet-5-5", cache });
  const values = Object.values(verdicts);
  assert.equal(values.filter((v) => v.verdict === "uncertain").length, 15, "the failed batch");
  assert.equal(Object.keys(cache.verdicts).length, 1, "only the successful verdict is cached");
  assert.equal(stats.usage.errors, 1);
});

test("when every request fails, the pre-audit fails with the API message", async () => {
  const error = new Anthropic.BadRequestError(
    400,
    { error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace" } },
    "400",
    new Headers(),
  );
  await assert.rejects(
    judge([item("6.1", "Accueil")], { client: fakeClient({ fail: error }), model: "claude-sonnet-5-5", cache: { version: 1, verdicts: {} } }),
    /every AI request failed \(400: This API key is not scoped to a workspace\)/,
  );
});

test("the workspace id is sent as a header when set", () => {
  const client = createClient({ ANTHROPIC_API_KEY: "k", ANTHROPIC_WORKSPACE_ID: "wrkspc_1" });
  assert.equal(client._options.defaultHeaders["anthropic-workspace-id"], "wrkspc_1");
  assert.equal(createClient({ ANTHROPIC_API_KEY: "k" })._options.defaultHeaders, undefined);
});

test("proposals and estimated rate", async () => {
  const items = [item("6.1", "Accueil"), item("6.1", "Cliquez ici"), item("11.2", "Nom")];
  const { verdicts } = await judge(items, { client: fakeClient(), model: "claude-sonnet-5-5", cache: { version: 1, verdicts: {} } });
  const ai = proposals(items, verdicts);
  assert.equal(ai["6.1"].proposal, "invalidated");
  assert.equal(ai["6.1"].invalid[0].name, "Cliquez ici");
  assert.equal(ai["11.2"].proposal, "validated");
  const criteria = [
    { id: "1.1", status: "validated" },
    { id: "3.2", status: "invalidated" },
    { id: "6.1", status: "to_review" },
    { id: "11.2", status: "to_review" },
    { id: "3.1", status: "to_review" },
  ];
  assert.deepEqual(estimatedRate(criteria, ai), { validated: 2, invalidated: 2, value: 50 });
});

test("elements lists every judged element once per state, without screenshots", async () => {
  const a = item("1.3", "Logo", { image: "iVBORw0KGgo=" });
  const items = [a, a, { ...a, state: "s2" }, item("6.1", "Cliquez ici")];
  const { verdicts } = await judge(items, { client: fakeClient(), model: "claude-sonnet-5-5", cache: { version: 1, verdicts: {} } });
  const list = elements(items, verdicts);
  assert.deepEqual(list.map((e) => [e.criterion, e.state, e.verdict]), [["1.3", "s1", "valid"], ["1.3", "s2", "valid"], ["6.1", "s1", "invalid"]]);
  assert.equal(list[0].image, undefined);
});
