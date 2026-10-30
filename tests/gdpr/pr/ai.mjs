// AI review of a pull request (MAIR-295): Claude reads the diff with the personal data inventory
// and says whether the PR seems to touch personal data. It only warns (annotation and job summary)
// when the author answered "No" or when the inventory may need an entry; the verdict of the check
// stays the deterministic one (checklist.mjs). Answers are cached by fingerprint (model, diff,
// answer), so re-running the check on an edited description does not ask again.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { loadCache, saveCache } from "../contract/ai.mjs";

export { loadCache, saveCache };
export const MAX_DIFF_CHARS = 150_000;
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const SYSTEM = `You assist the data protection review of Mairie 360, a platform that French town halls
use for their agents (directory, calendar, messaging, projects, e-learning). You receive the personal
data inventory of its PostgreSQL schema, then the diff of a pull request of one of its repositories
(APIs in Rust, BFFs in TypeScript, Next.js fronts, the database, the CI). Say whether the change
touches personal data: it adds, renames or drops a column, returns, stores, logs, sends to a third
party, exports or deletes values of personal columns, or changes who can read them. Formatting,
tests that only use fixtures, dependency bumps and CI plumbing do not touch personal data. Cite the
files and say why in one short English sentence each. Say whether the inventory needs a change
(a column added, renamed, dropped, or its erasure / visibility changed).`;

const Review = z.object({
  touches_personal_data: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  inventory_change_needed: z.boolean(),
  findings: z.array(z.object({ file: z.string(), reason: z.string() })),
});

// Lock files and generated contracts carry no decision and fill the context.
export function reviewableDiff(diff) {
  const parts = diff.split(/^(?=diff --git )/m);
  const kept = parts.filter((part) => !/^diff --git a\/\S*(?:package-lock\.json|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|\.d\.ts|openapi\.json)\s/.test(part));
  const text = kept.join("");
  return text.length > MAX_DIFF_CHARS ? { text: text.slice(0, MAX_DIFF_CHARS), truncated: true } : { text, truncated: false };
}

export function fingerprint(model, diff, answer) {
  return createHash("sha256").update(JSON.stringify([model, answer, createHash("sha256").update(diff).digest("hex")])).digest("hex").slice(0, 32);
}

// Returns { review, cached, error, usage }.
export async function reviewPullRequest({ client, model, inventoryText, diff, answer, cache }) {
  const { text, truncated } = reviewableDiff(diff);
  const key = fingerprint(model, text, answer);
  if (cache.answers[key]) return { review: cache.answers[key], cached: true, error: null, usage: null, truncated };
  if (!text.trim()) return { review: null, cached: false, error: "empty diff", usage: null, truncated };
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort: "low", format: betaZodOutputFormat(Review) },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `Inventory:\n${inventoryText}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `The author answered "${answer ?? "nothing"}" to "does this PR touch personal data?".${truncated ? " The diff is truncated." : ""}\n\n${text}` }],
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
      return { review: null, cached: false, error: `no usable answer (${response.stop_reason})`, usage: response.usage ?? null, truncated };
    }
    cache.answers[key] = response.parsed_output;
    return { review: response.parsed_output, cached: false, error: null, usage: response.usage ?? null, truncated };
  } catch (caught) {
    if (!(caught instanceof Anthropic.APIError)) throw caught;
    return { review: null, cached: false, error: `API error ${caught.status ?? "network"}: ${caught.error?.error?.message ?? caught.message}`.slice(0, 300), usage: null, truncated };
  }
}

// The warning to show, or null: a "No" that looks like a "Yes", or a "Yes" whose inventory may
// need an entry the PR does not bring.
export function warning(answer, review, { inventoryChanged }) {
  if (!review || !review.touches_personal_data) return null;
  if (answer === "no") return `the PR is marked "No personal data" but Claude (${review.confidence} confidence) finds that it touches personal data`;
  if (answer === "yes" && review.inventory_change_needed && !inventoryChanged) return "Claude finds that the inventory needs a change: check that the Database PR referenced brings it";
  return null;
}
