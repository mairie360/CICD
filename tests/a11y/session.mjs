// Session of a seed user (MAIR-316, MAIR-680). No login call: the services only check the
// signature, the expiry and that the user exists.
// - JWT_PRIVATE_KEY set (the run's Ed25519 key, PEM, the one the stack gives Core API): an EdDSA
//   JWT signed like Core signs it ({sub, role, exp, iss, aud}, `kid` = RFC 7638 thumbprint of the
//   public key). Since MAIR-680 the services refuse every HS256 token.
// - otherwise the historical HS256 JWT {sub, role, exp} signed with `session.jwt_secret`, the same
//   shape as the former static token of the ZAP stacks.
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";

const base64url = (input) => Buffer.from(input).toString("base64url");

export const SESSION_JWT_ISSUER = "mairie360-core";
export const SESSION_JWT_AUDIENCE = "mairie360";

export function signJwt(claims, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// EdDSA session JWT, as Core API signs it. `privateKeyPem` accepts `\n`-escaped line breaks, like
// the services do for their keys.
export function signSessionJwt(claims, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem.replaceAll("\\n", "\n"));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("JWT_PRIVATE_KEY is not an Ed25519 private key");
  }
  const { x } = createPublicKey(key).export({ format: "jwk" });
  // RFC 7638: SHA-256 of the canonical JWK (members in lexicographic order, no whitespace).
  const kid = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const payload = base64url(JSON.stringify({ ...claims, iss: SESSION_JWT_ISSUER, aud: SESSION_JWT_AUDIENCE }));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// Cookie to add to the browser context so that the front's same-origin proxy forwards it as a
// Bearer token. `now` and `env` are injectable for tests.
export function sessionCookie(scope, userName, now = Date.now(), env = process.env) {
  const user = scope.users[userName];
  const { jwt_secret: secret, jwt_timeout: timeout = 3600, cookie = "accessToken" } = scope.session ?? {};
  const claims = { sub: String(user.id), role: user.role, exp: Math.floor(now / 1000) + timeout };
  const privateKey = env.JWT_PRIVATE_KEY;
  if (!privateKey && !secret) {
    throw new Error("no session key: export JWT_PRIVATE_KEY (the run's Ed25519 key) or set session.jwt_secret");
  }
  const token = privateKey ? signSessionJwt(claims, privateKey) : signJwt(claims, secret);
  return { name: cookie, value: token, url: scope.target, httpOnly: true, sameSite: "Strict" };
}
