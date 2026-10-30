// AI review of the GDPR simulation (MAIR-497): Claude (Haiku 5.5 by default) reads the log
// templates, the browser console and storage, and samples of the free-text and JSON columns, and
// rates the risk that each one exposes personal data beyond what the processing needs. Every item
// carries a fingerprint; verdicts are cached by fingerprint and model, so two runs on the same code
// give the same verdicts. A high risk blocks unless gdpr-accepted-risks.yaml accepts it.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-haiku-5-5";
const BATCH_SIZE = 40;
// Models that accept `effort` (Haiku 4.5 does not, Haiku 5.5 does).
const EFFORT_MODELS = /^claude-(opus|sonnet|fable|haiku-5)-/;

const SYSTEM = `You review, for GDPR, what the test stack of Mairie 360 (a platform French town halls
use for their agents) wrote while fictitious users went through every operation. Values of those
users already found by exact search are masked as <email>, <first_name>, <last_name>, <phone>,
<password>; numbers, ids, dates and addresses are replaced by <n>, <uuid>, <date>, <ip>, <jwt>,
<hex>. For each item (a log line template of a service, a browser console message, a browser
storage entry, or a value of a free-text or JSON database column), rate the risk that it exposes
personal data beyond what the processing needs: "high" for a credential or token, a request body,
a person's identity or contact in a log or in browser storage, or a whole user record copied
where it does not belong; "medium" for indirect identification (user id with a behaviour, IP with
a timestamp) in a log kept long; "low" for an id or a status in an operational log; "none" when
nothing personal is there. Free text written by agents is expected in its own column: rate it by
what it reveals beyond that. Justify in one short English sentence. Return one verdict per id.`;

const Verdicts = z.object({
  verdicts: z.array(z.object({ id: z.string(), risk: z.enum(["none", "low", "medium", "high"]), justification: z.string() })),
});

export function aiSettings(env = process.env) {
  const disabled = (env.GDPR_AI ?? "").trim().toLowerCase() === "off";
  return {
    enabled: !disabled && Boolean(env.ANTHROPIC_API_KEY),
    reason: disabled ? "disabled by GDPR_AI=off" : env.ANTHROPIC_API_KEY ? null : "no ANTHROPIC_API_KEY",
    model: (env.GDPR_SIMULATION_AI_MODEL ?? "").trim() || DEFAULT_MODEL,
    cache: (env.GDPR_AI_CACHE ?? "").trim(),
  };
}

// items: [{ fingerprint, kind, where, text }]. Returns { verdicts: Map(fingerprint → { risk,
// justification }), asked, cached, error, usage }.
export async function review(items, { client, model, cache }) {
  const verdicts = new Map();
  const todo = [];
  for (const item of items) {
    const hit = cache.answers[`${model}:${item.fingerprint}`];
    if (hit) verdicts.set(item.fingerprint, hit);
    else if (!todo.some((t) => t.fingerprint === item.fingerprint)) todo.push(item);
  }
  const cached = verdicts.size;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let error = null;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE).map((item, k) => ({ id: `i${i + k + 1}`, ...item }));
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 8000,
        output_config: { ...(EFFORT_MODELS.test(model) ? { effort: "low" } : {}), format: betaZodOutputFormat(Verdicts) },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(batch.map(({ id, kind, where, text }) => ({ id, kind, where, text: text.slice(0, 2000) }))) }],
      });
      usage.input_tokens += response.usage?.input_tokens ?? 0;
      usage.output_tokens += response.usage?.output_tokens ?? 0;
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        error = response.stop_reason === "refusal" ? "the model refused" : "the model's answer was truncated";
        continue;
      }
      const byId = new Map((response.parsed_output?.verdicts ?? []).map((v) => [v.id, v]));
      for (const item of batch) {
        const v = byId.get(item.id);
        if (!v) continue;
        const verdict = { risk: v.risk, justification: v.justification };
        cache.answers[`${model}:${item.fingerprint}`] = verdict;
        verdicts.set(item.fingerprint, verdict);
      }
    } catch (caught) {
      if (!(caught instanceof Anthropic.APIError)) throw caught;
      error = `API error ${caught.status ?? "network"}: ${caught.error?.error?.message ?? caught.message}`.slice(0, 300);
      if (caught instanceof Anthropic.AuthenticationError || caught instanceof Anthropic.PermissionDeniedError) break;
    }
  }
  return { verdicts, asked: todo.length, cached, error, usage };
}
