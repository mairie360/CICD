// Journey of the log marker test (MAIR-290): the requests a repo declares in its
// `gdpr-marker.yaml`, played with the marker user's values, deliberate errors included.
import { parse } from "yaml";

export const MARKER_FIELDS = ["email", "first_name", "last_name", "phone", "password"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const TOP_KEYS = new Set(["version", "target", "wait", "env", "ignore", "steps"]);
const STEP_KEYS = new Set(["name", "request", "expect", "capture"]);
const REQUEST_KEYS = new Set(["method", "path", "headers", "json"]);
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function placeholders(value, found = []) {
  if (typeof value === "string") for (const [, name] of value.matchAll(PLACEHOLDER)) found.push(name);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, found));
  else if (isMapping(value)) Object.values(value).forEach((v) => placeholders(v, found));
  return found;
}

// Returns { errors, journey }: the errors name the step, the journey is normalized
// (method upper-case, `expect` a list, every capture as { from, sensitive }).
export function loadJourney(text) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { errors: [`not valid YAML: ${error.message}`], journey: null };
  }
  const errors = [];
  if (!isMapping(doc) || doc.version !== 1) return { errors: ["the file must be a mapping with `version: 1`"], journey: null };
  for (const key of Object.keys(doc).filter((k) => !TOP_KEYS.has(k)).sort()) errors.push(`unknown key \`${key}\``);
  if (typeof doc.target !== "string" || !/^https?:\/\/[^/]+$/.test(doc.target)) {
    errors.push("`target` must be the base URL of the service under test, without path (e.g. http://core:3000)");
  }
  if (doc.wait !== undefined && (typeof doc.wait !== "string" || !doc.wait.startsWith("/"))) errors.push("`wait` must be a path starting with /");
  const env = doc.env ?? [];
  if (!Array.isArray(env) || env.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
    errors.push("`env` must list environment variable names (e.g. ADMIN_JWT)");
  }
  const ignore = doc.ignore ?? [];
  if (!Array.isArray(ignore) || ignore.some((i) => !isMapping(i) || typeof i.service !== "string" || typeof i.reason !== "string" || !i.reason.trim())) {
    errors.push("`ignore` must list { service, reason }: a service whose logs may hold the marker, and why");
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    errors.push("`steps` must be a non-empty list");
    return { errors, journey: null };
  }

  const known = new Set([...MARKER_FIELDS.map((f) => `marker.${f}`), ...(Array.isArray(env) ? env.map((n) => `env.${n}`) : [])]);
  const steps = doc.steps.map((step, index) => {
    const label = `step ${index + 1}${isMapping(step) && step.name ? ` (${step.name})` : ""}`;
    if (!isMapping(step)) {
      errors.push(`${label}: must be a mapping`);
      return null;
    }
    for (const key of Object.keys(step).filter((k) => !STEP_KEYS.has(k)).sort()) errors.push(`${label}: unknown key \`${key}\``);
    if (typeof step.name !== "string" || !step.name.trim()) errors.push(`${label}: \`name\` is required`);
    const request = step.request;
    if (!isMapping(request)) {
      errors.push(`${label}: \`request\` is required`);
      return null;
    }
    for (const key of Object.keys(request).filter((k) => !REQUEST_KEYS.has(k)).sort()) errors.push(`${label}: unknown request key \`${key}\``);
    const method = String(request.method ?? "").toUpperCase();
    if (!METHODS.includes(method)) errors.push(`${label}: method must be one of ${METHODS.join(", ")}`);
    if (typeof request.path !== "string" || !request.path.startsWith("/")) errors.push(`${label}: path must start with /`);
    if (request.headers !== undefined && (!isMapping(request.headers) || Object.values(request.headers).some((v) => typeof v !== "string"))) {
      errors.push(`${label}: headers must map names to strings`);
    }
    const expect = step.expect === undefined ? null : [step.expect].flat();
    if (expect && expect.some((code) => !Number.isInteger(code) || code < 100 || code > 599)) errors.push(`${label}: expect must be status codes`);
    for (const name of placeholders(request)) {
      if (!known.has(name)) errors.push(`${label}: unknown placeholder {{${name}}} (marker.<field>, env.<NAME> listed in env, or a capture of an earlier step)`);
    }
    const capture = {};
    if (step.capture !== undefined) {
      if (!isMapping(step.capture)) errors.push(`${label}: capture must map names to body.<path>, header.<name> or cookie.<name>`);
      else {
        for (const [name, spec] of Object.entries(step.capture)) {
          const from = typeof spec === "string" ? spec : spec?.from;
          if (typeof from !== "string" || !/^(body(\.[^.]+)*|header\.[^.]+|cookie\.[^.]+)$/.test(from)) {
            errors.push(`${label}: capture ${name} must come from body.<path>, header.<name> or cookie.<name>`);
            continue;
          }
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name === "marker" || name === "env") errors.push(`${label}: capture name ${name} is not allowed`);
          capture[name] = { from, sensitive: typeof spec === "object" && spec.sensitive === true };
          known.add(name);
        }
      }
    }
    return { name: step.name, request: { method, path: request.path, headers: request.headers ?? {}, json: request.json }, expect, capture };
  });
  if (errors.length > 0) return { errors, journey: null };
  return {
    errors,
    journey: { target: doc.target, wait: doc.wait ?? null, env, ignore, steps },
  };
}

// Marker fields the journey sends, for the report: a field never sent is not tested.
export function usedFields(journey) {
  const used = new Set();
  for (const step of journey.steps) {
    for (const name of placeholders(step.request)) if (name.startsWith("marker.")) used.add(name.slice(7));
  }
  return MARKER_FIELDS.filter((f) => used.has(f));
}

export function render(value, context) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, name) => {
      const resolved = name.split(".").reduce((node, key) => (node == null ? undefined : node[key]), context);
      if (resolved === undefined) throw new Error(`{{${name}}} has no value`);
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, context));
  if (isMapping(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, context)]));
  return value;
}

function cookieFrom(headers, name) {
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

function extract(from, response, body) {
  const [kind, ...path] = from.split(".");
  if (kind === "header") return response.headers.get(path[0]) ?? undefined;
  if (kind === "cookie") return cookieFrom(response.headers, path[0]);
  return path.reduce((node, key) => (node == null ? undefined : node[key]), body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(url, { fetchImpl = fetch, timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetchImpl(url, { redirect: "manual" });
      if (response.status < 400) return true;
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// Plays the steps in order and stops at the first one that fails: the next ones would depend on
// its captures. Returns { results, sensitive }: no value is logged or returned in the results.
export async function play(journey, { marker, env = {}, fetchImpl = fetch, log = () => {} }) {
  const context = { marker, env: Object.fromEntries(journey.env.map((name) => [name, env[name]])) };
  const sensitive = {};
  const results = [];
  for (const step of journey.steps) {
    const result = { name: step.name, method: step.request.method, path: step.request.path, expected: step.expect, status: null, ok: false, error: null };
    results.push(result);
    try {
      const headers = render(step.request.headers, context);
      const init = { method: step.request.method, headers: { ...headers }, redirect: "manual" };
      if (step.request.json !== undefined) {
        init.body = JSON.stringify(render(step.request.json, context));
        init.headers["content-type"] ??= "application/json";
      }
      const response = await fetchImpl(`${journey.target}${render(step.request.path, context)}`, init);
      result.status = response.status;
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const expected = step.expect ?? null;
      if (expected ? !expected.includes(response.status) : response.status < 200 || response.status > 299) {
        result.error = `answered ${response.status}, expected ${expected ? expected.join(" or ") : "2xx"}`;
      } else {
        for (const [name, { from, sensitive: isSensitive }] of Object.entries(step.capture)) {
          const value = extract(from, response, body);
          if (value === undefined || value === null || value === "") {
            result.error = `no ${from} to capture as ${name}`;
            break;
          }
          context[name] = value;
          if (isSensitive) sensitive[name] = String(value);
        }
      }
    } catch (error) {
      result.error = error.message;
    }
    result.ok = result.error === null;
    log(`${result.ok ? "ok  " : "FAIL"} ${step.name}: ${result.status ?? "-"}${result.error ? ` (${result.error})` : ""}`);
    if (!result.ok) break;
  }
  return { results, sensitive };
}
