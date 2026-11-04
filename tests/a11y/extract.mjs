// Extraction of the elements the AI pre-audit judges (MAIR-320), from a reached state. Each item
// carries what a reviewer needs to judge one relevance criterion, and a fingerprint so that a
// verdict is reused as long as the element does not change.
import { createHash } from "node:crypto";

// Bump when the prompts or the extracted fields change: every cached verdict is then re-judged.
export const EXTRACTION_VERSION = 4;

// Criteria of the first batch, each with the kind of element it judges.
export const AI_CRITERIA = {
  "1.3": "image",
  "6.1": "link",
  "11.2": "field",
  "11.9": "button",
  "13.5": "cryptic",
  "13.6": "cryptic",
  // Criteria that depend on the whole page: one item per state (11.3: one for all the states).
  "3.1": "page",
  "7.4": "controls",
  "9.1": "headings",
  "11.3": "labels",
};

// The kinds that describe a whole page rather than one element.
export const PAGE_KINDS = new Set(["page", "controls", "headings", "labels"]);
const MAX_PAGE_SHOT_HEIGHT = 4000;
const MAX_ARIA_CHARS = 30000;

const MAX_ITEMS_PER_KIND = 60;
const MAX_IMAGE_SIDE = 800;

function inPageExtract({ kinds, max }) {
  const { visible, target } = window.__rgaa;
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  // Rendered text (innerText keeps the spaces between blocks: "Lun 15", not "Lun15").
  const rendered = (el) => text(el?.innerText ?? el?.textContent);
  // Text of a label without the controls nested in it (a <label> wrapping its <select> must not
  // name the field after every option), blocks separated by spaces, like the accessible name.
  const CONTROLS = "select, option, optgroup, input, textarea, [role=listbox], [role=option], [role=slider]";
  const labelText = (label) => {
    if (!label) return "";
    const parts = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && parent !== label && parent.closest(CONTROLS) && label.contains(parent.closest(CONTROLS))) continue;
      parts.push(node.textContent);
    }
    return text(parts.join(" "));
  };
  const byIds = (ids) => text((ids ?? "").split(/\s+/).map((id) => labelText(document.getElementById(id))).join(" "));
  const name = (el) =>
    text(el.getAttribute("aria-label")) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    (el.id ? text([...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map(labelText).join(" ")) : "") ||
    labelText(el.closest("label")) ||
    text(el.getAttribute("alt")) ||
    text(el.getAttribute("title")) ||
    rendered(el);
  // Short text around the element: its nearest block container, without the element itself.
  const context = (el) => {
    const block = el.parentElement?.closest("p, li, td, th, dd, article, section, form, fieldset, header, nav, div") ?? el.parentElement;
    const own = rendered(el);
    return rendered(block).replace(own, " … ").slice(0, 240);
  };
  const opening = (el, { keepValue = true } = {}) => {
    const outer = el.outerHTML;
    // data-rgaa-ai: an element extracted as a field and then as a button is already marked.
    const tag = outer.slice(0, outer.indexOf(">") + 1).replace(/\s(class|style|data-rgaa-ai)="[^"]*"/g, "");
    // The value of a field is data (the seed, what a step typed), not markup: it would mislead the
    // judge and change the fingerprint with the data.
    return (keepValue ? tag : tag.replace(/\svalue="[^"]*"/g, "")).slice(0, 300);
  };
  const items = [];
  const push = (kind, el, fields) => {
    if (items.filter((i) => i.kind === kind).length >= max) return;
    // Read the markup before marking the element: the marker must not reach the html (nor the
    // fingerprint), or the same component would change fingerprint with its position.
    const html = opening(el, { keepValue: kind !== "field" });
    const item = { kind, index: items.length, target: target(el), html, context: context(el), ...fields };
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
  const FIELDS = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [role="textbox"], [role="combobox"], [role="searchbox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"]';
  const fieldType = (el) => el.getAttribute("type") ?? el.getAttribute("role") ?? el.localName;
  if (kinds.includes("field")) {
    const fields = FIELDS;
    for (const el of document.querySelectorAll(fields)) {
      if (!visible(el)) continue;
      push("field", el, {
        name: name(el),
        type: fieldType(el),
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
  // Page-level items (MAIR-320): what the criterion is judged on, for the whole state.
  const page = (kind, fields) => items.push({ kind, index: items.length, target: "document", html: "", context: "", name: text(document.title), ...fields });
  if (kinds.includes("headings")) {
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
      .filter((el) => visible(el) && !el.closest('[aria-hidden="true"]'))
      .slice(0, 150)
      .map((el) => ({ level: Number(el.getAttribute("aria-level") ?? (/^h\d$/.test(el.localName) ? el.localName.slice(1) : 2)), text: rendered(el).slice(0, 120) }));
    page("headings", { headings });
  }
  if (kinds.includes("labels")) {
    const seen = new Set();
    const fields = [];
    for (const el of document.querySelectorAll(FIELDS)) {
      if (!visible(el)) continue;
      const field = { name: name(el), type: fieldType(el), autocomplete: el.getAttribute("autocomplete") ?? "" };
      const key = JSON.stringify(field);
      if (!seen.has(key) && fields.length < 150) fields.push(field) && seen.add(key);
    }
    if (fields.length > 0) page("labels", { fields });
  }
  if (kinds.includes("controls")) {
    // Controls whose change could start a script that changes the context (7.4): lists, choices,
    // switches. Whether their form has a submit button and what describes them helps the judge.
    const controls = [];
    for (const el of document.querySelectorAll('select, input[type="radio"], input[type="checkbox"], [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [role="switch"]')) {
      if (!visible(el) || controls.length >= 80) continue;
      const form = el.closest("form");
      controls.push({
        name: name(el),
        type: fieldType(el),
        in_form: Boolean(form),
        form_has_submit: Boolean(form?.querySelector('button[type="submit"], button:not([type]), input[type="submit"]')),
        description: byIds(el.getAttribute("aria-describedby")).slice(0, 160),
      });
    }
    if (controls.length > 0) page("controls", { controls });
  }
  if (kinds.includes("page")) page("page", {});
  return items;
}

// 11.3 is judged on the whole set of pages: the labels items of every state become one item, with
// each distinct field once (sorted, so that the order of the states does not matter).
export function mergeSiteItems(items) {
  const labels = items.filter((i) => i.criterion === "11.3");
  if (labels.length === 0) return items;
  const fields = new Map();
  for (const item of labels) for (const f of item.fields) fields.set(JSON.stringify(f), f);
  const base = {
    kind: "labels",
    index: 0,
    target: "document",
    html: "",
    context: "",
    name: "Ensemble des pages",
    fields: [...fields.keys()].sort().map((k) => fields.get(k)),
  };
  const merged = { ...base, criterion: "11.3", state: [...new Set(labels.map((i) => i.state))].join(", "), fingerprint: itemFingerprint("11.3", base) };
  const first = items.indexOf(labels[0]);
  return [...items.slice(0, first), merged, ...items.slice(first + 1).filter((i) => i.criterion !== "11.3")];
}

// Fields that do not change the verdict of a criterion stay out of its fingerprint, so that the same
// component in several stories or pages is judged once. The context matters for images and links
// (an alt or a link text is judged against it), much less for button names, labels and symbols.
export const CONTEXT_FREE = new Set(["11.2", "11.9", "13.5", "13.6", "3.1", "7.4", "9.1", "11.3"]);

export function itemFingerprint(criterion, item) {
  const { target, index, image, image_type, state, ...judged } = item;
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

  // 3.1 (colour): the page as rendered, its ARIA snapshot, and a digest of the markup with its
  // classes and styles, so that the verdict is reused until the page or its styles change.
  for (const element of elements.filter((e) => e.kind === "page")) {
    element.aria = (await page.locator("body").ariaSnapshot()).slice(0, MAX_ARIA_CHARS);
    element.markup = createHash("sha256").update(await page.evaluate(() => window.__rgaa.normalizedHtml({ keepStyles: true }))).digest("hex");
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    const clip = { x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, Math.min(size.height, MAX_PAGE_SHOT_HEIGHT)) };
    const shot = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, clip }).catch(() => null);
    if (shot) {
      element.image = shot.toString("base64");
      element.image_type = "image/jpeg";
      element.truncated = size.height > MAX_PAGE_SHOT_HEIGHT;
    }
  }

  return criteria.flatMap((criterion) =>
    elements
      .filter((e) => e.kind === AI_CRITERIA[criterion])
      .map((e) => ({ ...e, criterion, state: stateId, fingerprint: itemFingerprint(criterion, e) })),
  );
}
