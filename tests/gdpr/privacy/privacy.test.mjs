import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePrivacy, parseSetCookie, summarizePrivacy } from "./privacy.mjs";

test("Set-Cookie lines are parsed with their flags", () => {
  assert.deepEqual(parseSetCookie("accessToken=abc; Path=/; HttpOnly; Secure; SameSite=Strict"), {
    name: "accessToken", httpOnly: true, secure: true, sameSite: "Strict",
  });
  assert.deepEqual(parseSetCookie("_ga=GA1.2; Max-Age=3600"), { name: "_ga", httpOnly: false, secure: false, sameSite: null });
});

test("third parties, cookies and missing legal links are reported, the session cookies pass", () => {
  const ok = { legal_notice: true, privacy_policy: true };
  const states = [
    {
      id: "home",
      story: false,
      privacy: {
        requests: [
          { origin: "http://front:5000", type: "document", example: "http://front:5000/" },
          { origin: "https://fonts.googleapis.com", type: "stylesheet", example: "https://fonts.googleapis.com/css2" },
          { origin: "https://tiles.example.org", type: "image", example: "https://tiles.example.org/1.png" },
        ],
        set_cookies: [
          { name: "accessToken", httpOnly: true, secure: true, sameSite: "Strict" },
          { name: "passwordChangeToken", httpOnly: true, secure: false, sameSite: "Lax" },
        ],
        js_cookies: [{ name: "theme", httpOnly: false, secure: false, sameSite: "Lax" }],
        legal: { legal_notice: true, privacy_policy: false },
      },
    },
    { id: "story", story: true, privacy: { requests: [], set_cookies: [], js_cookies: [], legal: { legal_notice: false, privacy_policy: false } } },
    { id: "profile", story: false, privacy: { requests: [], set_cookies: [], js_cookies: [], legal: ok } },
    { id: "unreached", story: false, privacy: null },
  ];
  const result = evaluatePrivacy(states, {
    target: "http://front:5000",
    allowedOrigins: [{ origin: "https://tiles.example.org", reason: "map tiles" }],
  });
  assert.equal(result.checked, 3);
  assert.deepEqual(result.third_party.map((t) => [t.origin, t.types, t.states]), [["https://fonts.googleapis.com", ["stylesheet"], ["home"]]]);
  assert.deepEqual(result.cookies.map((c) => [c.name, c.via, c.problems]), [
    ["passwordChangeToken", "Set-Cookie", ["not Secure"]],
    ["theme", "document.cookie", ["not a session cookie", "not HttpOnly", "not Secure"]],
  ]);
  assert.deepEqual(result.legal_missing, [{ state: "home", missing: ["privacy policy"] }], "stories are not pages");
  const summary = summarizePrivacy(result);
  assert.match(summary, /⚠️ 4 finding\(s\) over 3 state\(s\)/);
  assert.match(summary, /`https:\/\/fonts.googleapis.com` \| stylesheet/);
  assert.match(summarizePrivacy(evaluatePrivacy([states[2]], { target: "http://front:5000" })), /✅ 1 state\(s\)/);
});
