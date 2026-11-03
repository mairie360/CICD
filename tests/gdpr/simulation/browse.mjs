// Browser part of the GDPR simulation of a front (MAIR-497, MAIR-292). After a persona's journey,
// and before its erasure, the pages of the `browser` section of gdpr-simulation.yaml are opened in
// a fresh browser context with the session cookies, through tests/gdpr/privacy: the browser
// console and storage then hold whatever the front printed or kept while the persona's data was
// on screen, and the requests and cookies of each page feed the privacy findings (report-only).
//
//   browser:
//     target: http://projects-front:5001        # the front's origin on the stack
//     cookies: {accessToken: "{{env.ADMIN_JWT}}"}
//     allowed_origins: [{origin: http://login-front.test, reason: login redirect}]   # optional
//     pages:
//       - name: project page
//         path: "/projects/{{project_id}}"       # captures of the journey, marker.<field>, env.<NAME>
//         expect: [200]                          # optional, default: any status below 400
import { MARKER_FIELDS, render } from "../marker/journey.mjs";

const BROWSER_KEYS = new Set(["target", "cookies", "allowed_origins", "pages"]);
const PAGE_KEYS = new Set(["name", "path", "expect"]);
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function names(value) {
  return typeof value === "string" ? [...value.matchAll(PLACEHOLDER)].map(([, n]) => n) : [];
}

// Checks the section against the journey it follows (its env and captures). Returns the errors and
// the normalized section ({ target, cookies, allowedOrigins, pages }), or null without a section.
export function loadBrowser(doc, journey) {
  if (doc === undefined) return { errors: [], browser: null };
  const errors = [];
  if (!isMapping(doc)) return { errors: ["`browser` must be a mapping (target, cookies, pages)"], browser: null };
  for (const key of Object.keys(doc).filter((k) => !BROWSER_KEYS.has(k))) errors.push(`browser: unknown key \`${key}\``);
  if (typeof doc.target !== "string" || !/^https?:\/\/[^/]+$/.test(doc.target)) {
    errors.push("browser: `target` must be the front's origin on the stack, without path (e.g. http://projects-front:5001)");
  }
  const known = new Set([
    ...MARKER_FIELDS.map((f) => `marker.${f}`),
    ...journey.env.map((e) => `env.${e}`),
    ...journey.steps.flatMap((s) => Object.keys(s.capture)),
  ]);
  const checkPlaceholders = (value, label) => {
    for (const name of names(value)) {
      if (!known.has(name)) errors.push(`${label}: unknown placeholder {{${name}}} (marker.<field>, env.<NAME> of the journey, or a capture of the journey)`);
    }
  };
  const cookies = doc.cookies ?? {};
  if (!isMapping(cookies) || Object.values(cookies).some((v) => typeof v !== "string")) errors.push("browser: `cookies` must map cookie names to strings");
  else for (const [name, value] of Object.entries(cookies)) checkPlaceholders(value, `browser: cookie ${name}`);
  const allowed = doc.allowed_origins ?? [];
  if (!Array.isArray(allowed) || allowed.some((o) => !isMapping(o) || typeof o.origin !== "string" || typeof o.reason !== "string" || !o.reason.trim())) {
    errors.push("browser: `allowed_origins` must list {origin, reason}");
  }
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) errors.push("browser: `pages` must list at least one page");
  const pages = [];
  for (const [i, page] of (Array.isArray(doc.pages) ? doc.pages : []).entries()) {
    const label = `browser: page ${i + 1}`;
    if (!isMapping(page)) {
      errors.push(`${label} must be a mapping (name, path)`);
      continue;
    }
    for (const key of Object.keys(page).filter((k) => !PAGE_KEYS.has(k))) errors.push(`${label}: unknown key \`${key}\``);
    if (typeof page.name !== "string" || !page.name.trim()) errors.push(`${label}: \`name\` is required`);
    if (typeof page.path !== "string" || !page.path.startsWith("/")) errors.push(`${label}: \`path\` must start with /`);
    else checkPlaceholders(page.path, `${label} (${page.name})`);
    if (page.expect !== undefined && (!Array.isArray(page.expect) || page.expect.some((c) => !Number.isInteger(c)))) errors.push(`${label}: \`expect\` must list status codes`);
    pages.push({ name: page.name, path: page.path, expect: page.expect ?? null });
  }
  if (errors.length > 0) return { errors, browser: null };
  return { errors, browser: { target: doc.target, cookies, allowedOrigins: allowed, pages } };
}

// Opens every page of the section for one persona. `context` holds marker, env and the journey's
// captures; `recordPage(browser, url, { cookies })` is tests/gdpr/privacy's. Returns
// { results, states, console, storage } (states in evaluatePrivacy's shape); no value is logged.
export async function browsePersona(section, { browser, persona, context, recordPage, log = () => {} }) {
  const cookies = Object.entries(section.cookies).map(([name, value]) => ({
    name, value: render(value, context), url: section.target, httpOnly: true, sameSite: "Strict",
  }));
  const results = [];
  const states = [];
  const consoleEntries = [];
  const storage = [];
  for (const page of section.pages) {
    const state = `${persona} ${page.name}`;
    const result = { name: `page ${page.name}`, method: "BROWSER", path: page.path, expected: page.expect, status: null, ok: false, error: null };
    results.push(result);
    try {
      const recorded = await recordPage(browser, `${section.target}${render(page.path, context)}`, { cookies });
      result.status = recorded.status;
      if (page.expect ? !page.expect.includes(recorded.status) : recorded.status === null || recorded.status >= 400) {
        result.error = `answered ${recorded.status ?? "nothing"}, expected ${page.expect ? page.expect.join(" or ") : "a status below 400"}`;
      }
      states.push({ id: state, story: false, privacy: recorded });
      for (const m of recorded.console) consoleEntries.push({ state, type: m.type, text: m.text });
      for (const s of recorded.storage) storage.push({ state, area: s.area, key: s.key, value: s.value });
    } catch (error) {
      result.error = error.message;
    }
    result.ok = result.error === null;
    log(`${result.ok ? "ok  " : "FAIL"} ${result.name}: ${result.status ?? "-"}${result.error ? ` (${result.error})` : ""}`);
  }
  return { results, states, console: consoleEntries, storage };
}
