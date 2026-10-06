// Extraction of the elements the AI pre-audit judges (MAIR-320), from a reached state. Each item
// carries what a reviewer needs to judge one relevance criterion, and a fingerprint so that a
// verdict is reused as long as the element does not change.
import { createHash } from "node:crypto";

// Bump when the prompts or the extracted fields change: every cached verdict is then re-judged.
export const EXTRACTION_VERSION = 2;

// Criteria of the first batch, each with the kind of element it judges.
export const AI_CRITERIA = {
  "1.3": "image",
  "6.1": "link",
  "11.2": "field",
  "11.9": "button",
  "13.5": "cryptic",
  "13.6": "cryptic",
};

const MAX_ITEMS_PER_KIND = 60;
const MAX_IMAGE_SIDE = 800;

function inPageExtract({ kinds, max }) {
  const { visible, target } = window.__rgaa;
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  // Rendered text (innerText keeps the spaces between blocks: "Lun 15", not "Lun15").
  const rendered = (el) => text(el?.innerText ?? el?.textContent);
  const byIds = (ids) => text((ids ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const name = (el) =>
    text(el.getAttribute("aria-label")) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    (el.id ? text([...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map((l) => l.textContent).join(" ")) : "") ||
    rendered(el.closest("label")) ||
    text(el.getAttribute("alt")) ||
    text(el.getAttribute("title")) ||
    rendered(el);
  // Short text around the element: its nearest block container, without the element itself.
  const context = (el) => {
    const block = el.parentElement?.closest("p, li, td, th, dd, article, section, form, fieldset, header, nav, div") ?? el.parentElement;
    const own = rendered(el);
    return rendered(block).replace(own, " … ").slice(0, 240);
  };
  const opening = (el) => {
    const outer = el.outerHTML;
    return outer.slice(0, outer.indexOf(">") + 1).replace(/\s(class|style)="[^"]*"/g, "").slice(0, 300);
  };
  const items = [];
  const push = (kind, el, fields) => {
    if (items.filter((i) => i.kind === kind).length >= max) return;
    // Read the markup before marking the element: the marker must not reach the html (nor the
    // fingerprint), or the same component would change fingerprint with its position.
    const item = { kind, index: items.length, target: target(el), html: opening(el), context: context(el), ...fields };
    el.dataset.rgaaAi = String(item.index);
    items.push(item);
  };

  if (kinds.includes("image")) {
    for (const el of document.querySelectorAll('img, [role="img"], svg[role="img"], input[type="image"]')) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      const alt = el.localName === "img" || el.localName === "input" ? el.getAttribute("alt") : name(el);
      if (alt === null || text(alt) === "") continue; // decorative: 1.2, not 1.3
      push("image", el, { name: text(alt), src: (el.getAttribute("src") ?? "").slice(0, 200) });
    }
  }
  if (kinds.includes("link")) {
    for (const el of document.querySelectorAll("a[href], [role=link]")) {
      if (visible(el)) push("link", el, { name: name(el), href: (el.getAttribute("href") ?? "").slice(0, 200) });
    }
  }
  if (kinds.includes("field")) {
    const fields = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [role="textbox"], [role="combobox"], [role="searchbox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"]';
    for (const el of document.querySelectorAll(fields)) {
      if (!visible(el)) continue;
      push("field", el, {
        name: name(el),
        type: el.getAttribute("type") ?? el.getAttribute("role") ?? el.localName,
        placeholder: text(el.getAttribute("placeholder")),
        required: el.required || el.getAttribute("aria-required") === "true",
      });
    }
  }
  if (kinds.includes("button")) {
    for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]')) {
      if (!visible(el)) continue;
      push("button", el, {
        name: name(el) || text(el.getAttribute("value")),
        visible_text: rendered(el).slice(0, 120),
        popup: el.getAttribute("aria-haspopup") ?? "",
      });
    }
  }
  if (kinds.includes("cryptic")) {
    // Emoji, or symbols / ASCII art used as content (arrows, smileys, ★, …).
    const cryptic = /\p{Extended_Pictographic}|[←→↑↓⇒★☆✓✔✗✘•]|[:;]-?[)(DPp]|<-|->|\^\^/u;
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || !cryptic.test(node.textContent) || !visible(el) || el.closest("script, style")) continue;
      seen.add(el);
      push("cryptic", el, {
        name: name(el),
        text: rendered(el).slice(0, 160),
        role: el.getAttribute("role") ?? "",
        aria_hidden: el.closest('[aria-hidden="true"]') !== null,
      });
    }
  }
  return items;
}

// Fields that do not change the verdict of a criterion stay out of its fingerprint, so that the same
// component in several stories or pages is judged once. The context matters for images and links
// (an alt or a link text is judged against it), much less for button names, labels and symbols.
const CONTEXT_FREE = new Set(["11.2", "11.9", "13.5", "13.6"]);

export function itemFingerprint(criterion, item) {
  const { target, index, image, state, ...judged } = item;
  if (CONTEXT_FREE.has(criterion)) delete judged.context;
  return createHash("sha256")
    .update(`${EXTRACTION_VERSION}|${criterion}|${JSON.stringify(judged, Object.keys(judged).sort())}`)
    .digest("hex");
}

// Returns one entry per (criterion, element), for the AI criteria declared in the scope.
export async function extractItems(page, scope, stateId) {
  const criteria = scope.criteria.filter((c) => c in AI_CRITERIA);
  if (criteria.length === 0) return [];
  const kinds = [...new Set(criteria.map((c) => AI_CRITERIA[c]))];
  const elements = await page.evaluate(inPageExtract, { kinds, max: MAX_ITEMS_PER_KIND });

  // Images are judged on what they show: attach a screenshot of each one.
  for (const element of elements.filter((e) => e.kind === "image")) {
    const locator = page.locator(`[data-rgaa-ai="${element.index}"]`);
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2 || Math.max(box.width, box.height) > MAX_IMAGE_SIDE) continue;
    element.image = (await locator.screenshot({ type: "png" }).catch(() => null))?.toString("base64");
  }
  await page.evaluate(() => document.querySelectorAll("[data-rgaa-ai]").forEach((el) => delete el.dataset.rgaaAi));

  return criteria.flatMap((criterion) =>
    elements
      .filter((e) => e.kind === AI_CRITERIA[criterion])
      .map((e) => ({ ...e, criterion, state: stateId, fingerprint: itemFingerprint(criterion, e) })),
  );
}
