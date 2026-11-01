// Log templates of the GDPR simulation (MAIR-497): the lines of a service are grouped by their
// shape, numbers, ids and dates replaced, so that the AI review reads each kind of line once and
// its verdict is cached by the template's fingerprint (same code, same templates, same verdicts).
import { createHash } from "node:crypto";

const RULES = [
  // Password hashes and other salted secrets change at every run: masked, or each one would get
  // its own fingerprint and the cached verdicts would never apply.
  [/\$argon2(?:id|i|d)\$[^\s"'}\]]+/g, "<hash>"],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "<hash>"],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<date>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>"],
  [/\b[0-9a-f]{16,}\b/gi, "<hex>"],
  [/\b\d+(?:\.\d+)?(?:ms|µs|s)?\b/g, "<n>"],
];

export function templateOf(text) {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().slice(0, 600);
}

export const fingerprintOf = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);

// lines: [{ service, text }] (persona values already masked) → [{ service, template, count, fingerprint }].
// The compose replica suffix is dropped from the service (core-1 → core).
export function groupTemplates(lines) {
  const groups = new Map();
  for (const line of lines) {
    const service = line.service.replace(/-\d+$/, "");
    const template = templateOf(line.text);
    if (!template) continue;
    const key = `${service}\u0000${template}`;
    if (!groups.has(key)) groups.set(key, { service, template, count: 0, fingerprint: fingerprintOf("log", service, template) });
    groups.get(key).count += 1;
  }
  return [...groups.values()].sort((a, b) => a.service.localeCompare(b.service) || b.count - a.count);
}
