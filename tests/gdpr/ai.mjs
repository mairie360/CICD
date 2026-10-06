// AI proposals for the columns missing from the inventory (MAIR-285). Claude reads the inventory
// (its header documents the categories and the decisions already taken) and proposes a
// classification for each new column. Proposals only fill the report: the gate stays the
// deterministic comparison, and a human copies, fixes and commits the entries.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATEGORIES, ERASURES, VISIBILITIES } from "./inventory.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const BATCH_SIZE = 40;

// Models that accept the server-side refusal fallback in its "default" form.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const SYSTEM = `You assist the data protection review of Mairie 360, a platform that French town halls
use for their agents (directory, calendar, messaging, projects, e-learning). Mairie 360 is a GDPR
processor; the town hall is the controller. You receive the personal data inventory of its
PostgreSQL schema, then columns that are not classified yet, as JSON (table, column, SQL type,
nullability, column comment, table referenced by a foreign key). Propose a classification for each
of them, following the rules and the vocabulary of the inventory header, and stay consistent with
the decisions already taken in the inventory for similar columns (same table, same kind of link to
users, same kind of log). Only use what is given; when the purpose of a column cannot be told from
its name, type and table, say so in the note. Write each note in English, in one short sentence.
Return exactly one proposal per column id.`;

const Proposals = z.object({
  proposals: z.array(
    z.object({
      id: z.string(),
      personal: z.boolean(),
      category: z.enum(CATEGORIES).nullable(),
      erasure: z.enum(ERASURES).nullable(),
      visibility: z.enum(VISIBILITIES).nullable(),
      note: z.string(),
    }),
  ),
});

export function aiSettings(env = process.env) {
  const disabled = (env.GDPR_AI ?? "").trim().toLowerCase() === "off";
  return {
    enabled: !disabled && Boolean(env.ANTHROPIC_API_KEY),
    reason: disabled ? "disabled by GDPR_AI=off" : env.ANTHROPIC_API_KEY ? null : "no ANTHROPIC_API_KEY",
    model: (env.GDPR_AI_MODEL ?? "").trim() || DEFAULT_MODEL,
  };
}

function requestFor(model, inventoryText, batch) {
  const columns = batch.map(({ id, column }) => ({
    id,
    table: column.table_name,
    column: column.column_name,
    type: column.type,
    nullable: column.nullable,
    comment: column.comment ?? null,
    references: column.refers_to ?? null,
  }));
  return {
    model,
    max_tokens: 8000,
    output_config: { effort: "low", format: betaZodOutputFormat(Proposals) },
    // The inventory is the same for every batch of a run: cached after the first request.
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `Current inventory:\n${inventoryText}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: JSON.stringify(columns) }],
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

// `missing`: schema columns absent from the inventory. Returns { proposals, usage, error }:
// a proposal per column it could classify; `error` explains why the others have none.
export async function propose(missing, { client, model, inventoryText }) {
  const proposals = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let error = null;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE).map((column, k) => ({ id: `c${i + k + 1}`, column }));
    try {
      const response = await client.beta.messages.parse(requestFor(model, inventoryText, batch));
      for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] ?? 0;
      if (response.stop_reason === "refusal") {
        error = `the model refused (${response.stop_details?.category ?? "no category"})`;
        continue;
      }
      if (response.stop_reason === "max_tokens") {
        error = "the model's answer was truncated";
        continue;
      }
      const byId = new Map((response.parsed_output?.proposals ?? []).map((p) => [p.id, p]));
      for (const { id, column } of batch) {
        const proposal = byId.get(id);
        if (!proposal) continue;
        proposals.push({
          table: column.table_name,
          column: column.column_name,
          personal: proposal.personal,
          ...(proposal.personal ? { category: proposal.category, erasure: proposal.erasure, visibility: proposal.visibility } : {}),
          note: proposal.note,
        });
      }
    } catch (caught) {
      if (!(caught instanceof Anthropic.APIError)) throw caught;
      error = `API error ${caught.status ?? "network"}: ${caught.error?.error?.message ?? caught.message}`.slice(0, 300);
      // A key or permission problem fails every batch the same way.
      if (caught instanceof Anthropic.AuthenticationError || caught instanceof Anthropic.PermissionDeniedError) break;
    }
  }
  return { proposals, usage, error };
}

// The proposals as inventory YAML, grouped by table, ready to be reviewed and pasted.
export function proposalsYaml(proposals, model) {
  const byTable = new Map();
  for (const p of proposals) {
    if (!byTable.has(p.table)) byTable.set(p.table, []);
    byTable.get(p.table).push(p);
  }
  const quote = (text) => JSON.stringify(text);
  const lines = [`# Proposed by ${model}: review each entry before adding it to gdpr/inventory.yaml.`];
  for (const [table, list] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${table}:`);
    const personal = list.filter((p) => p.personal);
    const notPersonal = list.filter((p) => !p.personal);
    if (personal.length > 0) {
      lines.push("    personal:");
      for (const p of personal) {
        lines.push(`      ${p.column}: {category: ${p.category}, erasure: ${p.erasure}, visibility: ${p.visibility}, note: ${quote(p.note)}}`);
      }
    }
    if (notPersonal.length > 0) {
      for (const p of notPersonal) lines.push(`    # ${p.column}: ${p.note}`);
      lines.push(`    not_personal: [${notPersonal.map((p) => p.column).join(", ")}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}
