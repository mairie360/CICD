import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionCookie, signJwt } from "./session.mjs";

// Static token of the fronts' ZAP stacks (sub=2, role=user, exp=2100, JWT_SECRET=b"secret").
const ZAP_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIiwicm9sZSI6InVzZXIiLCJleHAiOjQxMDI0NDQ4MDB9.qjXr3pV4v8hvkbv_ufmNqaPqhDTbOGfTUeEXxa1z70U";

test("signs the same token as the ZAP stacks", () => {
  assert.equal(signJwt({ sub: "2", role: "user", exp: 4102444800 }, 'b"secret"'), ZAP_TOKEN);
});

test("the session cookie carries the user's claims and the stack timeout", () => {
  const scope = {
    target: "http://settings-front:5000",
    session: { jwt_secret: 'b"secret"', jwt_timeout: 600, cookie: "accessToken" },
    users: { agent: { id: 2, role: "user" } },
  };
  const cookie = sessionCookie(scope, "agent", 1_000_000_000_000);
  assert.equal(cookie.name, "accessToken");
  assert.equal(cookie.url, "http://settings-front:5000");
  const claims = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString());
  assert.deepEqual(claims, { sub: "2", role: "user", exp: 1_000_000_600 });
});

test("the runner image matches the playwright dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
  const image = readFileSync(new URL("./runner-image", import.meta.url), "utf8").trim();
  assert.match(image, /^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/);
  assert.equal(image.match(/:v([\d.]+)-/)[1], pkg.dependencies.playwright);
});
