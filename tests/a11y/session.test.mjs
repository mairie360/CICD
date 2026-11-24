import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { sessionCookie, signJwt, signSessionJwt } from "./session.mjs";

// Static token of the fronts' ZAP stacks (sub=2, role=user, exp=2100, JWT_SECRET=b"secret"): a test
// value, not a secret, hence the Gitleaks allow comment.
const ZAP_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIiwicm9sZSI6InVzZXIiLCJleHAiOjQxMDI0NDQ4MDB9.qjXr3pV4v8hvkbv_ufmNqaPqhDTbOGfTUeEXxa1z70U"; // gitleaks:allow

test("signs the same token as the ZAP stacks", () => {
  assert.equal(signJwt({ sub: "2", role: "user", exp: 4102444800 }, 'b"secret"'), ZAP_TOKEN);
});

test("the session cookie carries the user's claims and the stack timeout", () => {
  const scope = {
    target: "http://settings-front:5000",
    session: { jwt_secret: 'b"secret"', jwt_timeout: 600, cookie: "accessToken" },
    users: { agent: { id: 2, role: "user" } },
  };
  const cookie = sessionCookie(scope, "agent", 1_000_000_000_000, {});
  assert.equal(cookie.name, "accessToken");
  assert.equal(cookie.url, "http://settings-front:5000");
  const claims = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString());
  assert.deepEqual(claims, { sub: "2", role: "user", exp: 1_000_000_600 });
});

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());
const ed25519Pem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });

test("MAIR-680: with the run's Ed25519 key the session is an EdDSA token signed like Core", () => {
  const pem = ed25519Pem();
  const publicKey = createPublicKey(pem);
  const scope = {
    target: "http://settings-front:5000",
    // The HS256 secret of a scope not migrated yet is ignored once the key is given.
    session: { jwt_secret: 'b"secret"', jwt_timeout: 600 },
    users: { agent: { id: 2, role: "user" } },
  };
  const cookie = sessionCookie(scope, "agent", 1_000_000_000_000, { JWT_PRIVATE_KEY: pem });
  const [header, payload, signature] = cookie.value.split(".");
  const { x } = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  assert.deepEqual(decode(header), { alg: "EdDSA", typ: "JWT", kid });
  assert.deepEqual(decode(payload), {
    sub: "2", role: "user", exp: 1_000_000_600, iss: "mairie360-core", aud: "mairie360",
  });
  assert.ok(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
  assert.equal(cookie.name, "accessToken");
});

test("MAIR-680: the key may come with escaped line breaks, and a scope may have no HS256 secret", () => {
  const pem = ed25519Pem();
  const scope = { target: "http://front:5000", session: {}, users: { agent: { id: 2, role: "user" } } };
  const cookie = sessionCookie(scope, "agent", 1_000_000_000_000, { JWT_PRIVATE_KEY: pem.replaceAll("\n", "\\n") });
  assert.equal(decode(cookie.value.split(".")[0]).alg, "EdDSA");
  assert.equal(signSessionJwt({ sub: "2" }, pem).split(".").length, 3);
});

test("MAIR-680: a key that is not Ed25519 is refused, and so is a scope without any key", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => signSessionJwt({ sub: "2" }, rsa), /not an Ed25519 private key/);
  const scope = { target: "http://front:5000", session: {}, users: { agent: { id: 2, role: "user" } } };
  assert.throws(() => sessionCookie(scope, "agent", 0, {}), /no session key/);
});

test("the runner image matches the playwright dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
  const image = readFileSync(new URL("./runner-image", import.meta.url), "utf8").trim();
  assert.match(image, /^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/);
  assert.equal(image.match(/:v([\d.]+)-/)[1], pkg.dependencies.playwright);
});
