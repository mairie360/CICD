// GDPR checks of a front in the browser (MAIR-292, epic MAIR-284), recorded while the RGAA engine
// plays the declared states:
//
// - every request of the browser stays on the front's origin: no tracker, CDN, font or API
//   called from the browser (the fronts proxy their BFF on their own origin);
// - the cookies the front sets (Set-Cookie answers, and document.cookie) are only the session
//   ones, `accessToken` and `passwordChangeToken`, each HttpOnly, Secure and SameSite;
// - every page (not the Storybook stories) links to the legal notice and to the privacy policy.
//
// Report-only for now: the findings go to report.json (`privacy`) and the job summary, the exit
// code of the engine does not change (the fronts do not carry their legal pages yet).
// A front lists the other origins it is allowed to call, with the reason, in rgaa.yaml
// (`privacy.allowed_origins`).

export const SESSION_COOKIES = ["accessToken", "passwordChangeToken"];
const IGNORED_SCHEMES = new Set(["data:", "blob:", "about:", "chrome-extension:"]);
const LEGAL_NOTICE = /mentions\s+l[ée]gales|legal\s+notice/i;
const PRIVACY_POLICY = /confidentialit[ée]|donn[ée]es\s+personnelles|privacy/i;
const LEGAL_NOTICE_HREF = /mentions-legales|legal-notice|\/legal(?:$|[/?#])/i;
const PRIVACY_POLICY_HREF = /confidentialite|privacy|donnees-personnelles/i;

// "name=value; Path=/; HttpOnly; Secure; SameSite=Strict" → { name, httpOnly, secure, sameSite }.
export function parseSetCookie(line) {
  const [pair, ...attributes] = line.split(";").map((part) => part.trim());
  const name = pair.slice(0, Math.max(0, pair.indexOf("="))).trim();
  const cookie = { name, httpOnly: false, secure: false, sameSite: null };
  for (const attribute of attributes) {
    const [key, value = ""] = attribute.split("=").map((part) => part.trim());
    const lower = key.toLowerCase();
    if (lower === "httponly") cookie.httpOnly = true;
    else if (lower === "secure") cookie.secure = true;
    else if (lower === "samesite") cookie.sameSite = value || null;
  }
  return cookie;
}

// Starts recording on a browser context, before any page opens. Returns the recorder that
// `finishPrivacy` turns into the state's result.
export function watchPrivacy(context) {
  const recorder = { requests: new Map(), setCookies: [], pending: [], console: [] };
  // Browser console of the state, for the GDPR simulation (MAIR-497): a value logged there is a leak.
  context.on("console", (message) => recorder.console.push({ type: message.type(), text: message.text().slice(0, 2000) }));
  context.on("request", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (IGNORED_SCHEMES.has(url.protocol)) return;
    const key = `${url.origin} ${request.resourceType()}`;
    if (!recorder.requests.has(key)) recorder.requests.set(key, { origin: url.origin, type: request.resourceType(), example: `${url.origin}${url.pathname}` });
  });
  context.on("response", (response) => {
    recorder.pending.push(
      response.headersArray().then(
        (headers) => {
          for (const header of headers) {
            if (header.name.toLowerCase() === "set-cookie") {
              for (const line of header.value.split("\n")) {
                if (line.trim()) recorder.setCookies.push({ ...parseSetCookie(line), url: `${new URL(response.url()).origin}${new URL(response.url()).pathname}` });
              }
            }
          }
        },
        () => {},
      ),
    );
  });
  return recorder;
}

// The links of the page whose text, label or address points to the legal notice and to the
// privacy policy.
export async function legalLinks(page) {
  const links = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => ({
      text: `${a.textContent ?? ""} ${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("title") ?? ""}`.replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href") ?? "",
    })),
  );
  return {
    legal_notice: links.some((l) => LEGAL_NOTICE.test(l.text) || LEGAL_NOTICE_HREF.test(l.href)),
    privacy_policy: links.some((l) => PRIVACY_POLICY.test(l.text) || PRIVACY_POLICY_HREF.test(l.href)),
  };
}

// Result of one state: { requests, set_cookies, js_cookies, legal }. `injected` are the cookies
// the engine added itself (the session of `as`): they are not the front's.
export async function finishPrivacy(recorder, context, { page = null, injected = [] } = {}) {
  await Promise.all(recorder.pending);
  const fromHeaders = new Set(recorder.setCookies.map((c) => c.name));
  const jsCookies = (await context.cookies())
    .filter((c) => !injected.includes(c.name) && !fromHeaders.has(c.name))
    .map((c) => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
  // localStorage and sessionStorage of the page's origin, for the GDPR simulation (MAIR-497).
  const storage = page
    ? await page.evaluate(() => {
      const dump = (area, store) => Array.from({ length: store.length }, (_, i) => store.key(i)).map((key) => ({ area, key, value: String(store.getItem(key)).slice(0, 2000) }));
      try {
        return [...dump("local", window.localStorage), ...dump("session", window.sessionStorage)];
      } catch {
        return [];
      }
    }).catch(() => [])
    : [];
  return {
    requests: [...recorder.requests.values()],
    set_cookies: recorder.setCookies,
    js_cookies: jsCookies,
    legal: page ? await legalLinks(page) : null,
    console: recorder.console,
    storage,
  };
}

// The findings of a run: states = [{ id, story, privacy }] (privacy null for a state that was not
// recorded). Returns { third_party, cookies, legal_missing, checked }.
export function evaluatePrivacy(states, { target, allowedOrigins = [] }) {
  const origin = new URL(target).origin;
  const allowed = new Set([origin, ...allowedOrigins.map((o) => new URL(o.origin).origin)]);
  const thirdParty = new Map();
  const cookies = new Map();
  const legalMissing = [];
  let checked = 0;
  for (const state of states) {
    if (!state.privacy) continue;
    checked += 1;
    for (const request of state.privacy.requests) {
      if (allowed.has(request.origin)) continue;
      if (!thirdParty.has(request.origin)) thirdParty.set(request.origin, { origin: request.origin, types: new Set(), states: new Set(), example: request.example });
      thirdParty.get(request.origin).types.add(request.type);
      thirdParty.get(request.origin).states.add(state.id);
    }
    const all = [...state.privacy.set_cookies.map((c) => ({ ...c, via: "Set-Cookie" })), ...state.privacy.js_cookies.map((c) => ({ ...c, via: "document.cookie" }))];
    for (const cookie of all) {
      const problems = [];
      if (!SESSION_COOKIES.includes(cookie.name)) problems.push("not a session cookie");
      if (!cookie.httpOnly) problems.push("not HttpOnly");
      if (!cookie.secure) problems.push("not Secure");
      if (!cookie.sameSite || cookie.sameSite.toLowerCase() === "none") problems.push("no SameSite");
      if (problems.length === 0) continue;
      const key = `${cookie.name} ${cookie.via} ${problems.join(",")}`;
      if (!cookies.has(key)) cookies.set(key, { name: cookie.name, via: cookie.via, problems, states: new Set() });
      cookies.get(key).states.add(state.id);
    }
    if (!state.story && state.privacy.legal) {
      const missing = [];
      if (!state.privacy.legal.legal_notice) missing.push("legal notice");
      if (!state.privacy.legal.privacy_policy) missing.push("privacy policy");
      if (missing.length > 0) legalMissing.push({ state: state.id, missing });
    }
  }
  const list = (map) => [...map.values()].map((v) => ({ ...v, ...(v.types ? { types: [...v.types].sort() } : {}), states: [...v.states].sort() }));
  return { third_party: list(thirdParty), cookies: list(cookies), legal_missing: legalMissing, checked };
}

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

export function summarizePrivacy(result) {
  const findings = result.third_party.length + result.cookies.length + result.legal_missing.length;
  const lines = [
    "## GDPR in the browser (report-only)",
    "",
    findings === 0
      ? `✅ ${result.checked} state(s): requests on the front's origin only, session cookies only and with their flags, legal links present.`
      : `⚠️ ${findings} finding(s) over ${result.checked} state(s). Report-only for now (MAIR-292): it will block once the fronts carry their legal pages.`,
  ];
  if (result.third_party.length > 0) {
    lines.push("", "### Requests outside the front's origin", "", "| Origin | Types | States | Example |", "| --- | --- | --- | --- |");
    for (const t of result.third_party) lines.push(`| \`${t.origin}\` | ${t.types.join(", ")} | ${t.states.slice(0, 3).map((s) => `\`${s}\``).join(", ")}${t.states.length > 3 ? ` +${t.states.length - 3}` : ""} | \`${cell(t.example)}\` |`);
  }
  if (result.cookies.length > 0) {
    lines.push("", "### Cookies", "", "| Cookie | Set by | Problem | States |", "| --- | --- | --- | --- |");
    for (const c of result.cookies) lines.push(`| \`${c.name}\` | ${c.via} | ${c.problems.join(", ")} | ${c.states.slice(0, 3).map((s) => `\`${s}\``).join(", ")}${c.states.length > 3 ? ` +${c.states.length - 3}` : ""} |`);
  }
  if (result.legal_missing.length > 0) {
    lines.push("", "### Pages without legal links", "", "| State | Missing |", "| --- | --- |");
    for (const l of result.legal_missing) lines.push(`| \`${l.state}\` | ${l.missing.join(", ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
