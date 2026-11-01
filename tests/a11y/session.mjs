// Session of a seed user (MAIR-316): an HS256 JWT {sub, role, exp} signed with the test
// stack's JWT_SECRET, the same shape as the static token of the ZAP stacks. No login call:
// the APIs only check the signature, the expiry and that the user exists.
import { createHmac } from "node:crypto";

const base64url = (input) => Buffer.from(input).toString("base64url");

export function signJwt(claims, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// Cookie to add to the browser context so that the front's same-origin proxy forwards it as a
// Bearer token. `now` is injectable for tests.
export function sessionCookie(scope, userName, now = Date.now()) {
  const user = scope.users[userName];
  const { jwt_secret: secret, jwt_timeout: timeout = 3600, cookie = "accessToken" } = scope.session;
  const token = signJwt(
    { sub: String(user.id), role: user.role, exp: Math.floor(now / 1000) + timeout },
    secret,
  );
  return { name: cookie, value: token, url: scope.target, httpOnly: true, sameSite: "Strict" };
}
