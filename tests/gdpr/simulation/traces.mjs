// Traces and usage ledger of the GDPR simulation (MAIR-501): telemetry may only carry actions,
// never an identity. The stack's OpenTelemetry collector writes the spans with its `file`
// exporter (OTLP JSON, one export request per line) into <run dir>/traces.jsonl, and the usage
// ledger the instance would export goes to <run dir>/usage.json.

// Attributes that identify the caller or carry its input: never allowed in a span.
const FORBIDDEN_KEYS = [
  /^enduser\./,
  /^user\./,
  /^user_?id$/i,
  /^session\.id$/,
  /^http\.request\.header\.(authorization|cookie|x-api-key)$/i,
  /^url\.query$/,
];
// Attributes that hold a URL: allowed, but never with a query string.
const URL_KEYS = new Set(["url.full", "http.url", "http.target", "url.original"]);
// Keys that would identify a person in the exported ledger.
const LEDGER_KEYS = /^(user_?id|userId|email|e-mail|first_?name|last_?name|full_?name|phone|ip|ip_address)$/i;

function attributeValue(value) {
  if (value == null || typeof value !== "object") return value == null ? "" : String(value);
  if ("stringValue" in value) return String(value.stringValue);
  if ("intValue" in value) return String(value.intValue);
  if ("doubleValue" in value) return String(value.doubleValue);
  if ("boolValue" in value) return String(value.boolValue);
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(attributeValue).join(",");
  if ("kvlistValue" in value) return JSON.stringify(value.kvlistValue);
  return JSON.stringify(value);
}

const attributes = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, attributeValue(a.value)]));

// The lines of an OTLP JSON file export → [{ service, name, attributes }].
export function parseTraces(text) {
  const spans = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    for (const resourceSpans of request.resourceSpans ?? []) {
      const resource = attributes(resourceSpans.resource?.attributes);
      const service = resource["service.name"] ?? "unknown";
      for (const scope of resourceSpans.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          spans.push({ service, name: span.name ?? "", attributes: attributes(span.attributes) });
        }
      }
    }
  }
  return spans;
}

// The text a span is searched and reviewed as: its name and every attribute.
export const spanText = (span) => [span.name, ...Object.entries(span.attributes).map(([k, v]) => `${k}=${v}`)].join(" ");

// Attributes a span must never carry, whatever their value.
export function forbiddenAttributes(span) {
  const found = [];
  for (const [key, value] of Object.entries(span.attributes)) {
    if (FORBIDDEN_KEYS.some((pattern) => pattern.test(key))) found.push(key);
    else if (URL_KEYS.has(key) && /\?./.test(value)) found.push(`${key} (query string)`);
  }
  return found;
}

// Keys of the exported ledger that would identify a person, wherever they appear.
export function forbiddenLedgerKeys(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenLedgerKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]) => [
    ...(LEDGER_KEYS.test(key) ? [`${path}${path ? "." : ""}${key}`] : []),
    ...forbiddenLedgerKeys(v, `${path}${path ? "." : ""}${key}`),
  ]);
}
