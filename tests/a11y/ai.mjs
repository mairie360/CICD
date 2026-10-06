// AI pre-audit of the relevance criteria (MAIR-320). Claude judges the extracted elements whose
// fingerprint has no cached verdict; the verdicts never change the gating rate: they produce
// proposals and an estimated rate for the RGAA reviewer (MAIR-298).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const BATCH_SIZE = 15;
const CONCURRENCY = 3;

// Models that accept the server-side refusal fallback in its "default" form.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

// USD per million tokens, for the cost line of the report (other models: tokens only).
const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

const COMMON = `You assist the RGAA 4.1.2 accessibility reviewer of Mairie 360, a French municipal web platform.
You receive elements extracted from rendered pages (or component stories), as JSON, and judge each one
for ONE criterion only. Judge from the element, its accessible name and its surrounding text; do not
assume anything that is not given. Answer "valid" when the element complies, "invalid" when it clearly
does not, "uncertain" when the information given is not enough to decide. The interface is in French:
names in French are expected. Write each reason in French, one short sentence, naming what is wrong
or what makes it compliant. Return exactly one verdict per element id.`;

export const PROMPTS = {
  "1.3": `${COMMON}
Criterion 1.3: is the text alternative of each informative image relevant? The "name" is the alt (or
accessible name). A screenshot of the image is attached when available, labelled with the element id.
Invalid: file names, "image", "icon", "logo" alone when the logo carries a name, text that does not
describe what the image conveys in its context, an avatar alt that is not the person's name.`,
  "6.1": `${COMMON}
Criterion 6.1: is each link explicit? A link is explicit when its name alone, or its name together with
its context (the surrounding text given), lets the user know where it leads or what it does.
Invalid: "cliquez ici", "en savoir plus", "voir", "lien" without context that disambiguates them; a link
opening a file or a new window should say so.`,
  "11.2": `${COMMON}
Criterion 11.2: is the label of each form field relevant? The name must let the user know what to
enter; when a specific format is required (date, phone), the label or the placeholder context should
indicate it. Invalid: empty or generic labels ("champ", "texte", "input"), a placeholder used as the
only cue for a format, a label that does not match the field's purpose.`,
  "11.9": `${COMMON}
Criterion 11.9: is the accessible name of each button relevant? It must describe the action. When the
button shows visible text, the accessible name must contain that visible text. Invalid: empty names,
"bouton", a name that does not match the action, an icon-only button whose name does not say what
it does, an accessible name that does not contain the visible text.`,
  "13.5": `${COMMON}
Criterion 13.5: does each cryptic content (emoji, symbol, ASCII art, abbreviation used as content) have
an alternative where needed? Decorative symbols hidden from assistive technologies (aria_hidden true)
are valid. A meaningful emoji or symbol needs role="img" and an aria-label, or an equivalent text next
to it. Invalid: a meaningful symbol with no alternative.`,
  "13.6": `${COMMON}
Criterion 13.6: for each cryptic content that has an alternative (aria-label, title, adjacent text), is
that alternative relevant, i.e. does it convey the meaning of the symbol? Elements without any
alternative are "valid" here (they are judged by 13.5).`,
};

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["valid", "invalid", "uncertain"]),
      reason: z.string(),
    }),
  ),
});

export function aiSettings(env = process.env) {
  const disabled = (env.RGAA_AI ?? "").trim().toLowerCase() === "off";
  const cache = (env.RGAA_AI_CACHE ?? "").trim() || (existsSync("/ai-cache") ? "/ai-cache/verdicts.json" : "");
  return {
    enabled: !disabled && Boolean(env.ANTHROPIC_API_KEY),
    reason: disabled ? "disabled by RGAA_AI=off" : env.ANTHROPIC_API_KEY ? null : "no ANTHROPIC_API_KEY",
    model: (env.RGAA_AI_MODEL ?? "").trim() || DEFAULT_MODEL,
    cache,
  };
}

export function loadCache(file) {
  if (!file || !existsSync(file)) return { version: 1, verdicts: {} };
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    return cache?.version === 1 && cache.verdicts ? cache : { version: 1, verdicts: {} };
  } catch {
    return { version: 1, verdicts: {} };
  }
}

export function saveCache(file, cache) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache)}\n`);
}

// What the model sees of an item: no fingerprint, target or screenshot bytes.
function describe(item, id) {
  const { fingerprint, target, index, image, state, kind, criterion, ...fields } = item;
  return { id, ...fields };
}

function requestFor(model, criterion, batch) {
  const content = [{ type: "text", text: JSON.stringify(batch.map(({ id, item }) => describe(item, id))) }];
  for (const { id, item } of batch) {
    if (!item.image) continue;
    content.push({ type: "text", text: `Screenshot of element ${id}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: item.image } });
  }
  return {
    model,
    max_tokens: 8000,
    output_config: { effort: "low", format: betaZodOutputFormat(Verdicts) },
    // Same system prompt for every batch of a criterion: cached after the first request.
    system: [{ type: "text", text: PROMPTS[criterion], cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

function addUsage(total, usage, model) {
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    total[key] = (total[key] ?? 0) + (usage?.[key] ?? 0);
  }
  const price = PRICES[model];
  if (price) {
    total.cost_usd =
      Math.round(
        ((total.cost_usd ?? 0) +
          ((usage?.input_tokens ?? 0) * price.input +
            (usage?.output_tokens ?? 0) * price.output +
            (usage?.cache_read_input_tokens ?? 0) * price.cache_read +
            (usage?.cache_creation_input_tokens ?? 0) * price.cache_write) /
            1e6) *
          10000,
      ) / 10000;
  }
}

async function judgeBatch(client, model, criterion, batch, usage) {
  const uncertain = (reason) => batch.map(({ id }) => ({ id, verdict: "uncertain", reason }));
  try {
    const response = await client.beta.messages.parse(requestFor(model, criterion, batch));
    addUsage(usage, response.usage, model);
    if (response.stop_reason === "refusal") return uncertain(`refus du modèle (${response.stop_details?.category ?? "sans catégorie"})`);
    if (response.stop_reason === "max_tokens") return uncertain("réponse du modèle tronquée");
    const byId = new Map((response.parsed_output?.verdicts ?? []).map((v) => [v.id, v]));
    return batch.map(({ id }) => byId.get(id) ?? { id, verdict: "uncertain", reason: "pas de verdict renvoyé pour cet élément" });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw error;
    if (error instanceof Anthropic.APIError) return uncertain(`erreur de l'API (${error.status ?? "réseau"})`);
    throw error;
  }
}

// `items`: extracted items, possibly repeated across states. Returns verdicts by fingerprint and the
// run statistics; the cache object is updated in place.
export async function judge(items, { client, model, cache }) {
  const unique = new Map();
  for (const item of items) if (!unique.has(item.fingerprint)) unique.set(item.fingerprint, item);
  const todo = [...unique.values()].filter((item) => !cache.verdicts[item.fingerprint]);

  const batches = [];
  for (const criterion of Object.keys(PROMPTS)) {
    const list = todo.filter((item) => item.criterion === criterion);
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      batches.push({ criterion, batch: list.slice(i, i + BATCH_SIZE).map((item, k) => ({ id: `e${i + k + 1}`, item })) });
    }
  }

  const usage = {};
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const { criterion, batch } = batches[next];
      next += 1;
      const verdicts = await judgeBatch(client, model, criterion, batch, usage);
      verdicts.forEach((verdict, k) => {
        const { item } = batch[k];
        // Uncertain answers caused by an error are not cached: they are retried at the next run.
        if (/^(erreur|refus|réponse du modèle tronquée)/.test(verdict.reason)) return;
        cache.verdicts[item.fingerprint] = { verdict: verdict.verdict, reason: verdict.reason, model, criterion };
      });
      batch.forEach(({ item }, k) => (item.verdict = verdicts[k]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const verdicts = {};
  for (const [fingerprint, item] of unique) {
    verdicts[fingerprint] = cache.verdicts[fingerprint] ?? { ...item.verdict, model };
  }
  return {
    verdicts,
    stats: { elements: unique.size, judged: todo.length, cached: unique.size - todo.length, requests: batches.length, usage },
  };
}

// Per declared AI criterion: the proposal for the reviewer. Any invalid element invalidates the
// criterion; it is proposed as validated only when every element is valid.
export function proposals(items, verdicts) {
  const out = {};
  for (const item of items) {
    const verdict = verdicts[item.fingerprint];
    if (!verdict) continue;
    const entry = (out[item.criterion] ??= { elements: 0, valid: 0, invalid: [], uncertain: 0, seen: new Set() });
    if (entry.seen.has(item.fingerprint)) continue;
    entry.seen.add(item.fingerprint);
    entry.elements += 1;
    if (verdict.verdict === "valid") entry.valid += 1;
    else if (verdict.verdict === "uncertain") entry.uncertain += 1;
    else entry.invalid.push({ state: item.state, target: item.target, html: item.html, name: item.name, reason: verdict.reason });
  }
  for (const entry of Object.values(out)) {
    delete entry.seen;
    entry.proposal = entry.invalid.length > 0 ? "invalidated" : entry.uncertain === 0 ? "validated" : "uncertain";
  }
  return out;
}

// Estimated rate: the decided criteria, plus the AI proposals on the criteria left to review.
export function estimatedRate(criteria, ai) {
  let validated = 0;
  let invalidated = 0;
  for (const c of criteria) {
    const status = c.status === "to_review" ? ai[c.id]?.proposal : c.status;
    if (status === "validated") validated += 1;
    if (status === "invalidated") invalidated += 1;
  }
  const decided = validated + invalidated;
  return { validated, invalidated, value: decided === 0 ? null : Math.round((validated / decided) * 1000) / 10 };
}

export function createClient() {
  return new Anthropic({ maxRetries: 4 });
}
