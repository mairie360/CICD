// OpenAPI contract check (MAIR-291, epic MAIR-284): the response schemas an API or a BFF publishes
// must not carry a `credentials` column of the personal data inventory (password hash, session
// token hash...), unless the repo allows it in its decision file with the reason.
//
// A response field carries a column when it has the column's name, or when the repo's decision
// file `gdpr-contract.yaml` maps the field name to it (`fields`). Claude may propose such mappings
// for the other names (ai.mjs): they never change the verdict.
import { parse } from "yaml";

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const COLUMN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const OPERATION = /^(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) \/\S*$/;

function resolve(spec, schema) {
  if (!isMapping(schema) || typeof schema.$ref !== "string") return { schema, name: null };
  const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
  const name = match ? decodeURIComponent(match[1].replaceAll("~1", "/").replaceAll("~0", "~")) : null;
  return { schema: name ? spec.components?.schemas?.[name] : undefined, name };
}

// Every property of a response schema, at any depth: [{ name, pointer, schema }] where `schema`
// is the component the property belongs to (null for an inline object).
export function schemaFields(spec, root) {
  const fields = [];
  const walk = (node, pointer, owner, seen) => {
    const { schema, name } = resolve(spec, node);
    if (!isMapping(schema)) return;
    if (name) {
      if (seen.has(name)) return;
      seen = new Set([...seen, name]);
      owner = name;
    }
    for (const key of ["allOf", "oneOf", "anyOf"]) {
      if (Array.isArray(schema[key])) for (const part of schema[key]) walk(part, pointer, owner, seen);
    }
    if (schema.items) walk(schema.items, `${pointer}[]`, owner, seen);
    if (isMapping(schema.additionalProperties)) walk(schema.additionalProperties, `${pointer}{}`, owner, seen);
    if (isMapping(schema.properties)) {
      for (const [property, child] of Object.entries(schema.properties)) {
        const childPointer = pointer ? `${pointer}.${property}` : property;
        fields.push({ name: property, pointer: childPointer, schema: owner });
        walk(child, childPointer, owner, seen);
      }
    }
  };
  walk(root, "", null, new Set());
  return fields;
}

// [{ operation: "GET /users/{id}", status, field, pointer, schema }] for every response of the spec.
export function responseFields(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!isMapping(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const operation = `${method.toUpperCase()} ${path}`;
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        const resolved = isMapping(response) && response.$ref
          ? spec.components?.responses?.[String(response.$ref).split("/").pop()]
          : response;
        for (const media of Object.values(resolved?.content ?? {})) {
          for (const f of schemaFields(spec, media?.schema)) out.push({ operation, status, field: f.name, pointer: f.pointer, schema: f.schema });
        }
      }
    }
  }
  return out;
}

// The decision file of the repo, `gdpr-contract.yaml` (optional). Returns { errors, decisions }.
export function parseDecisions(text, entries) {
  const empty = { fields: new Map(), allow: [] };
  if (text === null || text === undefined) return { errors: [], decisions: empty };
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { errors: [`not valid YAML: ${error.message}`], decisions: empty };
  }
  if (!isMapping(doc) || doc.version !== 1) return { errors: ["the file must be a mapping with `version: 1`"], decisions: empty };
  const errors = [];
  for (const key of Object.keys(doc).filter((k) => !["version", "fields", "allow"].includes(k)).sort()) errors.push(`unknown key \`${key}\``);
  const fields = new Map();
  if (doc.fields !== undefined) {
    if (!isMapping(doc.fields)) errors.push("`fields` must map an API field name to a column (`table.column`)");
    else {
      for (const [name, column] of Object.entries(doc.fields)) {
        if (typeof column !== "string" || !COLUMN.test(column)) errors.push(`fields.${name}: must name a column as table.column`);
        else if (!entries.has(column)) errors.push(`fields.${name}: ${column} is not a column of the inventory`);
        else fields.set(name, column);
      }
    }
  }
  const allow = [];
  if (doc.allow !== undefined) {
    if (!Array.isArray(doc.allow)) errors.push("`allow` must list { operation, field, reason }");
    else {
      doc.allow.forEach((a, i) => {
        if (!isMapping(a) || typeof a.operation !== "string" || !OPERATION.test(a.operation) || typeof a.field !== "string" || !a.field
          || typeof a.reason !== "string" || !a.reason.trim()) {
          errors.push(`allow[${i}]: must be { operation: "METHOD /path", field, reason }`);
        } else allow.push({ operation: a.operation, field: a.field, reason: a.reason.trim() });
      });
    }
  }
  return { errors, decisions: { fields, allow } };
}

// The inventory columns a response field carries: the one its name is mapped to in the decision
// file, else every column of that name.
export function columnsOf(field, entries, decisions, byName = indexByName(entries)) {
  if (decisions.fields.has(field)) return [entries.get(decisions.fields.get(field))];
  return byName.get(field) ?? [];
}

export function indexByName(entries) {
  const byName = new Map();
  for (const entry of entries.values()) {
    if (!byName.has(entry.column)) byName.set(entry.column, []);
    byName.get(entry.column).push(entry);
  }
  return byName;
}

// Returns { violations, allowed, staleAllows, personal, unmapped }:
// - violations: a credentials column in a response, not allowed;
// - allowed: the same, allowed by the decision file (with its reason);
// - staleAllows: allows that match no response field (to remove);
// - personal: per operation, the personal columns its responses carry (for the access matrix);
// - unmapped: field names that match no column, with the schemas they appear in (AI candidates).
export function check(fields, entries, decisions) {
  const byName = indexByName(entries);
  const violations = [];
  const allowed = [];
  const used = new Set();
  const personal = new Map();
  const unmapped = new Map();
  for (const f of fields) {
    const columns = columnsOf(f.field, entries, decisions, byName);
    if (columns.length === 0) {
      if (!unmapped.has(f.field)) unmapped.set(f.field, new Set());
      if (f.schema) unmapped.get(f.field).add(f.schema);
      continue;
    }
    // Only the names that are personal in every table that has them (`email`, `phone_number`):
    // `id` or `status` would list users.id on every response.
    const personalColumns = columns.every((c) => c.personal) ? columns : [];
    for (const column of personalColumns) {
      if (!personal.has(f.operation)) personal.set(f.operation, new Set());
      personal.get(f.operation).add(`${column.table}.${column.column}`);
    }
    const credentials = columns.filter((c) => c.personal && c.category === "credentials");
    if (credentials.length === 0) continue;
    const finding = { ...f, columns: credentials.map((c) => `${c.table}.${c.column}`) };
    const allow = decisions.allow.find((a) => a.operation === f.operation && a.field === f.field);
    if (allow) {
      used.add(allow);
      allowed.push({ ...finding, reason: allow.reason });
    } else violations.push(finding);
  }
  const dedupe = (list) => [...new Map(list.map((v) => [`${v.operation} ${v.status} ${v.pointer}`, v])).values()];
  return {
    violations: dedupe(violations),
    allowed: dedupe(allowed),
    staleAllows: decisions.allow.filter((a) => !used.has(a)),
    personal: [...personal].map(([operation, columns]) => ({ operation, columns: [...columns].sort() })).sort((a, b) => a.operation.localeCompare(b.operation)),
    unmapped: [...unmapped].map(([field, schemas]) => ({ field, schemas: [...schemas].sort() })).sort((a, b) => a.field.localeCompare(b.field)),
  };
}
