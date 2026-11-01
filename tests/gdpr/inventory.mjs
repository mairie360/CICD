// Personal data inventory of a database (MAIR-285): format check, comparison with the migrated
// schema and diff between two versions. The inventory lives in the consumer repo
// (`gdpr/inventory.yaml` of Database); its format is documented in that file's header.
import { parse } from "yaml";

export const CATEGORIES = [
  "identifier", "identity", "contact", "credentials", "connection",
  "account", "activity", "content", "preferences",
];
export const ERASURES = ["delete", "anonymize", "keep"];
export const VISIBILITIES = ["self", "members", "directory", "admin", "internal"];
const PERSONAL_KEYS = new Set(["category", "erasure", "visibility", "audit_log", "note"]);
const TABLE_KEYS = new Set(["audited", "personal", "not_personal"]);

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const REDIS_KEYS = new Set(["personal", "category", "max_ttl_seconds", "note"]);

// The optional `redis` section (MAIR-499): every key prefix the APIs and BFFs write, with whether
// it holds personal data, its category then, and its maximum TTL in seconds (every Redis write
// carries one). Returns { errors, prefixes: Map(prefix -> { personal, category?, max_ttl_seconds, note? }) }.
export function parseRedisSection(section) {
  const errors = [];
  const prefixes = new Map();
  if (section === undefined) return { errors, prefixes };
  if (!isMapping(section)) return { errors: ["`redis` must map each key prefix to { personal, max_ttl_seconds }"], prefixes };
  for (const [prefix, entry] of Object.entries(section)) {
    const name = `redis ${prefix}`;
    if (!isMapping(entry)) {
      errors.push(`${name}: must be a mapping with personal and max_ttl_seconds`);
      continue;
    }
    for (const key of Object.keys(entry).filter((k) => !REDIS_KEYS.has(k)).sort()) errors.push(`${name}: unknown key \`${key}\``);
    if (typeof entry.personal !== "boolean") errors.push(`${name}: personal must be true or false`);
    if (entry.personal === true && !CATEGORIES.includes(entry.category)) errors.push(`${name}: category must be one of ${CATEGORIES.join(", ")}`);
    if (entry.personal === false && entry.category !== undefined) errors.push(`${name}: category only applies to a personal prefix`);
    if (!Number.isInteger(entry.max_ttl_seconds) || entry.max_ttl_seconds < 1) errors.push(`${name}: max_ttl_seconds must be a whole number of seconds (every Redis key expires)`);
    if (entry.note !== undefined && (typeof entry.note !== "string" || !entry.note.trim())) errors.push(`${name}: note must be a non-empty string`);
    prefixes.set(prefix, { personal: entry.personal, ...(entry.category ? { category: entry.category } : {}), max_ttl_seconds: entry.max_ttl_seconds, ...(entry.note ? { note: entry.note } : {}) });
  }
  return { errors, prefixes };
}

// Returns { errors, entries, redis }: entries maps "table.column" to its classification, redis
// the Redis key prefixes (see parseRedisSection).
export function parseInventory(text) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { errors: [`not valid YAML: ${error.message}`], entries: new Map() };
  }
  const errors = [];
  const entries = new Map();
  if (!isMapping(doc) || doc.version !== 1) return { errors: ["the file must be a mapping with `version: 1`"], entries };
  if (!isMapping(doc.tables) || Object.keys(doc.tables).length === 0) {
    return { errors: ["`tables` must be a non-empty mapping"], entries };
  }
  for (const [table, spec] of Object.entries(doc.tables)) {
    if (!isMapping(spec)) {
      errors.push(`${table}: must be a mapping`);
      continue;
    }
    for (const key of Object.keys(spec).filter((k) => !TABLE_KEYS.has(k)).sort()) errors.push(`${table}: unknown key \`${key}\``);
    const audited = spec.audited ?? false;
    if (typeof audited !== "boolean") errors.push(`${table}: \`audited\` must be true or false`);
    let personal = spec.personal ?? {};
    let notPersonal = spec.not_personal ?? [];
    if (!isMapping(personal)) {
      errors.push(`${table}: \`personal\` must map each column to its classification`);
      personal = {};
    }
    if (!Array.isArray(notPersonal)) {
      errors.push(`${table}: \`not_personal\` must be a list of columns`);
      notPersonal = [];
    }
    if (Object.keys(personal).length === 0 && notPersonal.length === 0) errors.push(`${table}: lists no column`);
    for (const [column, entry] of Object.entries(personal)) {
      const name = `${table}.${column}`;
      if (!isMapping(entry)) {
        errors.push(`${name}: must be a mapping with category, erasure and visibility`);
        continue;
      }
      for (const key of Object.keys(entry).filter((k) => !PERSONAL_KEYS.has(k)).sort()) errors.push(`${name}: unknown key \`${key}\``);
      if (!CATEGORIES.includes(entry.category)) errors.push(`${name}: category must be one of ${CATEGORIES.join(", ")}`);
      if (!ERASURES.includes(entry.erasure)) errors.push(`${name}: erasure must be one of ${ERASURES.join(", ")}`);
      if (!VISIBILITIES.includes(entry.visibility)) errors.push(`${name}: visibility must be one of ${VISIBILITIES.join(", ")}`);
      const auditLog = entry.audit_log ?? true;
      if (typeof auditLog !== "boolean") errors.push(`${name}: audit_log must be true or false`);
      else if (!auditLog && audited !== true) errors.push(`${name}: audit_log only applies to an audited table`);
      if (entry.note !== undefined && (typeof entry.note !== "string" || !entry.note.trim())) {
        errors.push(`${name}: note must be a non-empty string`);
      }
      entries.set(name, {
        table, column, personal: true, category: entry.category, erasure: entry.erasure,
        visibility: entry.visibility, audit_log: auditLog, ...(entry.note ? { note: entry.note } : {}),
      });
    }
    for (const column of notPersonal) {
      if (typeof column !== "string") {
        errors.push(`${table}: \`not_personal\` must only hold column names`);
        continue;
      }
      const name = `${table}.${column}`;
      if (entries.has(name)) errors.push(entries.get(name).personal ? `${name}: listed both as personal and not personal` : `${name}: listed twice`);
      else entries.set(name, { table, column, personal: false });
    }
  }
  const redis = parseRedisSection(doc.redis);
  return { errors: [...errors, ...redis.errors], entries, redis: redis.prefixes };
}

// `schema`: the columns of the migrated database, as written by schema.sql
// ([{ table_name, column_name, type, nullable, comment, refers_to }]).
export function compare(entries, schema) {
  const columns = new Map(schema.map((c) => [`${c.table_name}.${c.column_name}`, c]));
  const missing = [...columns.keys()].filter((name) => !entries.has(name)).map((name) => columns.get(name));
  const stale = [...entries.keys()].filter((name) => !columns.has(name)).sort();
  // A column that references users identifies an agent, whatever its name.
  const notIdentifier = schema
    .filter((c) => c.refers_to === "users" && entries.has(`${c.table_name}.${c.column_name}`))
    .filter((c) => entries.get(`${c.table_name}.${c.column_name}`).category !== "identifier")
    .map((c) => `${c.table_name}.${c.column_name}`);
  return { missing, stale, notIdentifier };
}

const FIELDS = ["personal", "category", "erasure", "visibility", "audit_log", "note"];

// What changed between two inventories: what the prod approver reviews.
export function diff(previous, current) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, entry] of current) {
    const before = previous.get(name);
    if (!before) {
      added.push(entry);
      continue;
    }
    const fields = FIELDS.filter((f) => (before[f] ?? null) !== (entry[f] ?? null));
    if (fields.length > 0) changed.push({ name, fields: fields.map((f) => ({ field: f, from: before[f] ?? null, to: entry[f] ?? null })) });
  }
  for (const name of previous.keys()) if (!current.has(name)) removed.push(name);
  return { added, removed: removed.sort(), changed };
}

export function describeEntry(entry) {
  if (!entry.personal) return "not personal";
  const parts = [entry.category, `erasure ${entry.erasure}`, `visible to ${entry.visibility}`];
  if (entry.audit_log === false) parts.push("out of the audit log");
  return parts.join(", ");
}
