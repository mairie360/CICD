// The simulation only runs on a test stack (MAIR-497): it writes fictitious people, erases them and
// back-dates rows. It refuses when it is not told so explicitly, or when a target of the run is not
// a host of the stack's private network.
import { isIP } from "node:net";

const PRIVATE_V4 = [/^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isStackHost(host) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost") return true;
  if (isIP(name) === 4) return PRIVATE_V4.some((r) => r.test(name));
  if (isIP(name) === 6) return name === "::1" || name.startsWith("fd") || name.startsWith("fc");
  // A compose service name has no dot; *.test / *.localhost are reserved for tests (RFC 2606/6761).
  return !name.includes(".") || /\.(test|localhost|internal)$/.test(name);
}

// Throws unless GDPR_SIMULATION=test-stack and every URL points into the stack.
export function assertTestStack(urls, env = process.env) {
  if ((env.GDPR_SIMULATION ?? "").trim() !== "test-stack") {
    throw new Error("refusing to run: GDPR_SIMULATION=test-stack is not set (the simulation writes, erases and back-dates data: test stacks only)");
  }
  for (const url of urls) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`refusing to run: ${url} is not a URL`);
    }
    if (!isStackHost(host)) throw new Error(`refusing to run: ${host} is not a host of a test stack (compose service, localhost or private address)`);
  }
}
