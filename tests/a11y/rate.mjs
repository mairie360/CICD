// Official RGAA rate of the automated checks and the dev -> staging gate (MAIR-319).
//
// Boolean and unweighted: a criterion is validated only if every check passes on every element
// of every state. The CI rate only counts the criteria the automated checks decide:
//   - invalidated: a check failed (a failure is certain, whatever the coverage);
//   - validated:   coverage full, no failure and nothing left to review;
//   - to_review:   anything else (partial or no coverage, axe "incomplete", scenario error). These
//                  go to the RGAA reviewer in the n8n chain (MAIR-298) and are not in the CI rate.
// CI rate = validated / (validated + invalidated).

export const DEFAULT_MIN_RATE = 60;

export function criterionStatus(criterion) {
  if (criterion.failures.length > 0) return "invalidated";
  if (criterion.coverage === "full" && criterion.review.length === 0) return "validated";
  return "to_review";
}

// RGAA_MIN_RATE (percent, 0-100) overrides the default; an empty value keeps it.
export function minRate(env = process.env) {
  const raw = (env.RGAA_MIN_RATE ?? "").trim();
  if (raw === "") return DEFAULT_MIN_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`RGAA_MIN_RATE must be a percentage between 0 and 100, got "${raw}"`);
  }
  return value;
}

// `criteria` carry a `status`. With no decided criterion there is nothing to gate: the rate is
// null and the gate passes (every criterion goes to the reviewer).
export function computeRate(criteria, min) {
  const count = (status) => criteria.filter((c) => c.status === status).length;
  const validated = count("validated");
  const invalidated = count("invalidated");
  const decided = validated + invalidated;
  const value = decided === 0 ? null : Math.round((validated / decided) * 1000) / 10;
  return { validated, invalidated, to_review: count("to_review"), value, min, passed: value === null || value >= min };
}
