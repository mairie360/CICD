// Loads criteria.yaml and aggregates the per-state check results per declared criterion
// (MAIR-318). The status and the rate are computed from this by MAIR-319.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export function loadCriteria() {
  return parse(readFileSync(new URL("./criteria.yaml", import.meta.url), "utf8")).criteria;
}

// `states` are the run results; a reached state carries `checks` ({ "<check>": { failures, review } }).
export function aggregate(scope, criteria, states) {
  return scope.criteria.map((id) => {
    const { level, coverage, checks } = criteria[id];
    const failures = [];
    const review = [];
    for (const state of states.filter((s) => s.checks)) {
      for (const check of checks) {
        const result = state.checks[check];
        if (!result) continue;
        failures.push(...result.failures.map((f) => ({ state: state.id, check, ...f })));
        review.push(...result.review.map((r) => ({ state: state.id, check, ...r })));
      }
    }
    return { id, level, coverage, checks, failures, review };
  });
}
