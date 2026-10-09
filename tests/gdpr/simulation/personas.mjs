// Fictitious personas of the GDPR simulation (MAIR-497): unique values for one run, built like the
// marker user of MAIR-290, so that any of them found in a log, a console, a browser storage or a
// database column after its erasure betrays a leak.
import { generateMarker, needles } from "../marker/marker.mjs";

// `count` personas, the last `erased` of them erased during the run.
export function generatePersonas(count, erased = 0, random) {
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("the number of personas must be between 1 and 50");
  if (!Number.isInteger(erased) || erased < 0 || erased > count) throw new Error("the number of erased personas must be between 0 and the number of personas");
  return Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, erase: i >= count - erased, values: generateMarker(random) }));
}

// The needles of every persona, each tagged with its persona: [{ persona, field, variant, text }].
export function personaNeedles(personas) {
  return personas.flatMap((p) => needles(p.values).map((n) => ({ ...n, persona: p.id, field: n.field })));
}
