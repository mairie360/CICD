// Redis side of the GDPR simulation (MAIR-497, MAIR-499): after the run, every key of the stack's
// Redis must expire, within the maximum TTL the inventory declares for its prefix, and match a
// declared prefix. The repo's script dumps the keys with
//   redis-cli --scan | while read k; do printf '%s\t%s\n' "$k" "$(redis-cli TTL "$k")"; done
// into <run dir>/redis/keys.tsv; sql.mjs writes the declared prefixes to <run dir>/redis_prefixes.json.

// "core-api:{user_id}/first_connection_token" → /^core-api:[^:/]+\/first_connection_token$/
export function prefixPattern(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^:/]+");
  return new RegExp(`^${escaped}$`);
}

export function parseKeys(tsv) {
  return tsv.split("\n").filter((line) => line.trim()).map((line) => {
    const at = line.lastIndexOf("\t");
    return { key: line.slice(0, at), ttl: Number(line.slice(at + 1)) };
  });
}

// keys: [{ key, ttl }] (ttl -1 = no expiry, -2 = gone). prefixes: { prefix: { max_ttl_seconds } }.
// Returns the findings: [{ check: "redis", where, excerpt }] — the key name is reported as its
// declared prefix, or masked to its first segment when undeclared (a key can hold a value).
export function checkRedis(keys, prefixes) {
  const declared = Object.entries(prefixes).map(([prefix, spec]) => ({ prefix, spec, pattern: prefixPattern(prefix) }));
  const findings = [];
  for (const { key, ttl } of keys) {
    if (ttl === -2) continue;
    const match = declared.find((d) => d.pattern.test(key));
    const where = match ? match.prefix : `${key.split(/[:/]/)[0]}:…`;
    if (!match) findings.push({ check: "redis", where, excerpt: "key prefix not declared in the inventory (redis section)" });
    if (ttl === -1) findings.push({ check: "redis", where, excerpt: "key without TTL" });
    else if (match && ttl > match.spec.max_ttl_seconds) findings.push({ check: "redis", where, excerpt: `TTL ${ttl} s above the declared maximum of ${match.spec.max_ttl_seconds} s` });
  }
  return [...new Map(findings.map((f) => [`${f.where} ${f.excerpt}`, f])).values()];
}
