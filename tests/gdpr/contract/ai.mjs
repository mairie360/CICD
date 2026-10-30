// AI proposals of the contract check (MAIR-291): for the response field names that match no column
// of the inventory, Claude says which column, if any, the field exposes under another name
// (`token` for sessions.token_hash, `mail` for users.email). The proposals only fill the report;
// a human writes the mapping into the repo's gdpr-contract.yaml, and the deterministic check then
// applies it. Answers are cached by fingerprint (field name + schemas it appears in + model), like
// the RGAA verdicts, so a run only asks about the names it has never seen.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { DEFAULT_MODEL } from "../ai.mjs";

const BATCH_SIZE = 80;
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const SYSTEM = `You assist the data protection review of Mairie 360, a platform that French town halls
use for their agents. You receive the personal data inventory of its PostgreSQL schema, then field
names found in the JSON responses of one of its HTTP APIs, each with the response schemas it
appears in. For each field, say which column of the inventory it exposes under another name, if
any: the value it most likely carries, not a column it merely relates to (a field holding the id of
a user exposes users.id only if it is that id). Answer null when it exposes no column, or when you
cannot tell from the name and the schemas. Write the reason in English, in one short sentence.
Return exactly one answer per field id.`;

const Answers = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      column: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

export function aiSettings(env = process.env) {
  const disabled = (env.GDPR_AI ?? "").trim().toLowerCase() === "off";
  return {
    enabled: !disabled && Boolean(env.ANTHROPIC_API_KEY),
    reason: disabled ? "disabled by GDPR_AI=off" : env.ANTHROPIC_API_KEY ? null : "no ANTHROPIC_API_KEY",
    model: (env.GDPR_AI_MODEL ?? "").trim() || DEFAULT_MODEL,
    cache: (env.GDPR_AI_CACHE ?? "").trim(),
  };
}

export function fingerprint(model, { field, schemas }) {
  return createHash("sha256").update(JSON.stringify([model, field, [...schemas].sort()])).digest("hex").slice(0, 32);
}

export function loadCache(file) {
  if (!file || !existsSync(file)) return { version: 1, answers: {} };
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    return cache?.version === 1 && cache.answers ? cache : { version: 1, answers: {} };
  } catch {
    return { version: 1, answers: {} };
  }
}

export function saveCache(file, cache) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache)}\n`);
}

// `unmapped`: [{ field, schemas }]. Returns { proposals, asked, cached, usage, error }: a proposal
// ({ field, schemas, column, reason }) for every field mapped to a column of the inventory.
export async function proposeMappings(unmapped, { client, model, inventoryText, entries, cache }) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const known = (column) => column !== null && entries.has(column);
  const answers = new Map();
  const todo = [];
  for (const item of unmapped) {
    const key = fingerprint(model, item);
    if (cache.answers[key]) answers.set(item.field, cache.answers[key]);
    else todo.push({ ...item, key });
  }
  const cached = answers.size;
  let error = null;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE).map((item, k) => ({ id: `f${i + k + 1}`, ...item }));
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 8000,
        output_config: { effort: "low", format: betaZodOutputFormat(Answers) },
        system: [
          { type: "text", text: SYSTEM },
          { type: "text", text: `Inventory:\n${inventoryText}`, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: JSON.stringify(batch.map(({ id, field, schemas }) => ({ id, field, schemas }))) }],
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      });
      for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        error = response.stop_reason === "refusal" ? "the model refused" : "the model's answer was truncated";
        continue;
      }
      const byId = new Map((response.parsed_output?.answers ?? []).map((a) => [a.id, a]));
      for (const item of batch) {
        const answer = byId.get(item.id);
        if (!answer) continue;
        // A column outside the inventory is an invalid answer: cached as "none", never shown.
        const value = { column: known(answer.column) ? answer.column : null, reason: answer.reason };
        cache.answers[item.key] = value;
        answers.set(item.field, value);
      }
    } catch (caught) {
      if (!(caught instanceof Anthropic.APIError)) throw caught;
      error = `API error ${caught.status ?? "network"}: ${caught.error?.error?.message ?? caught.message}`.slice(0, 300);
      if (caught instanceof Anthropic.AuthenticationError || caught instanceof Anthropic.PermissionDeniedError) break;
    }
  }
  const proposals = unmapped
    .filter((item) => answers.get(item.field)?.column)
    .map((item) => ({ ...item, ...answers.get(item.field) }));
  return { proposals, asked: todo.length, cached, usage, error };
}
