// GDPR checklist of a pull request (MAIR-295, epic MAIR-284). The organization PR template
// (mairie360/.github) asks whether the PR touches personal data; the author's answer is the human
// decision, and this check makes sure it is given and followed:
//
// - exactly one of "No" / "Yes" is ticked in the "Personal data" section of the description;
// - "Yes" goes with the inventory: in the repo that holds it (Database), the PR changes
//   gdpr/inventory.yaml; elsewhere the "Inventory:" line of the answer links to the Database PR
//   that updates it, or says why it does not change.
//
// Claude may warn that a PR answered "No" seems to touch personal data (ai.mjs): never blocking.

const BOX = /^\s*[-*]\s*\[( |x|X)\]\s*(No|Yes)\b(.*)$/;
const INVENTORY = /^\s*(?:[-*]\s*)?Inventory\s*:\s*(.*)$/i;
const PLACEHOLDER = /^(?:<[^>]*>|_+|\.{3}|…|n\/?a|-|)$/i;

// The answer of the description: { answer: "yes" | "no" | null, inventory: string | null, errors }.
export function parseAnswer(body) {
  const lines = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s*Personal data\b/i.test(line));
  if (start === -1) {
    return { answer: null, inventory: null, errors: ["the description has no \"Personal data\" section (organization PR template, MAIR-295)"] };
  }
  let end = lines.findIndex((line, i) => i > start && /^#{1,6}\s/.test(line));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end);
  const ticked = [];
  let inventory = null;
  for (const line of section) {
    const box = BOX.exec(line);
    if (box && box[1] !== " ") ticked.push({ value: box[2].toLowerCase(), rest: box[3] });
    const inv = INVENTORY.exec(line.replace(/^\s*[-*]\s*\[[ xX]\]\s*Yes\b\W*/, ""));
    if (inv) inventory = inv[1].trim();
  }
  if (ticked.length === 0) return { answer: null, inventory, errors: ["tick \"No\" or \"Yes\" in the \"Personal data\" section"] };
  if (ticked.length > 1) return { answer: null, inventory, errors: ["tick only one of \"No\" and \"Yes\" in the \"Personal data\" section"] };
  return { answer: ticked[0].value, inventory: inventory && !PLACEHOLDER.test(inventory) ? inventory : null, errors: [] };
}

// Verdict of the deterministic check. `changedFiles`: paths changed by the PR; `inventoryPath`:
// the inventory's path when this repo holds it (Database), else null.
export function verdict({ answer, inventory, errors }, { changedFiles, inventoryPath }) {
  if (errors.length > 0) return { ok: false, reasons: errors };
  if (answer === "no") return { ok: true, reasons: [] };
  if (inventoryPath) {
    return changedFiles.includes(inventoryPath)
      ? { ok: true, reasons: [] }
      : { ok: false, reasons: [`the PR touches personal data but does not change ${inventoryPath}`] };
  }
  return inventory
    ? { ok: true, reasons: [] }
    : { ok: false, reasons: ["the PR touches personal data: fill the \"Inventory:\" line with the Database PR that updates gdpr/inventory.yaml, or why it does not change"] };
}
