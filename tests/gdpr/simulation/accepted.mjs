// Accepted risks of the GDPR simulation (MAIR-497): the human decisions, versioned in the consumer
// repo (`gdpr-accepted-risks.yaml`). A high-risk AI finding whose fingerprint is listed no longer
// blocks; the deterministic checks cannot be accepted (fix the leak instead).
import { parse } from "yaml";

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseAccepted(text) {
  if (text === null || text === undefined) return { errors: [], accepted: new Map() };
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { errors: [`not valid YAML: ${error.message}`], accepted: new Map() };
  }
  if (!isMapping(doc) || doc.version !== 1 || !Array.isArray(doc.risks ?? [])) {
    return { errors: ["the file must be a mapping with `version: 1` and a `risks` list"], accepted: new Map() };
  }
  const errors = [];
  const accepted = new Map();
  (doc.risks ?? []).forEach((risk, i) => {
    const label = `risks[${i}]`;
    if (!isMapping(risk)) return errors.push(`${label}: must be { fingerprint, reason, date, author }`);
    if (typeof risk.fingerprint !== "string" || !/^[0-9a-f]{24}$/.test(risk.fingerprint)) errors.push(`${label}: fingerprint must be the 24 hex characters of the report`);
    if (typeof risk.reason !== "string" || !risk.reason.trim()) errors.push(`${label}: reason is required`);
    const date = risk.date instanceof Date ? risk.date.toISOString().slice(0, 10) : risk.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`${label}: date must be YYYY-MM-DD`);
    if (typeof risk.author !== "string" || !risk.author.trim()) errors.push(`${label}: author is required`);
    if (accepted.has(risk.fingerprint)) errors.push(`${label}: fingerprint ${risk.fingerprint} is listed twice`);
    accepted.set(risk.fingerprint, { reason: risk.reason, date, author: risk.author });
  });
  return { errors, accepted: errors.length > 0 ? new Map() : accepted };
}
