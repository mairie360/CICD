// Playwright scenarios of the RGAA engine (MAIR-318). Each one returns its failures
// ({ target, html, message }); criteria.yaml maps them to criteria as `scenario:<id>`.
// They run on a reached state, in this order: read-only DOM checks, then layout checks (each one
// restores the viewport and styles it changes), then keyboard and hover, which move the focus.

const DESKTOP = { width: 1280, height: 800 };

const dom = (fn, arg) => (page) => page.evaluate(fn, arg);

// --- Read-only DOM checks --------------------------------------------------------------------

const doctype = dom(() =>
  document.doctype?.name?.toLowerCase() === "html"
    ? []
    : [{ target: "html", html: "", message: "missing <!DOCTYPE html>" }],
);

const duplicateIds = dom(() => {
  const seen = new Map();
  for (const el of document.querySelectorAll("[id]")) {
    if (!el.id) continue;
    seen.set(el.id, [...(seen.get(el.id) ?? []), el]);
  }
  return [...seen.entries()]
    .filter(([, els]) => els.length > 1)
    .map(([id, els]) => window.__rgaa.failure(els[1], `id "${id}" is used ${els.length} times`));
});

const langFr = dom(() => {
  const lang = document.documentElement.getAttribute("lang") ?? "";
  return /^fr(-|$)/i.test(lang)
    ? []
    : [{ target: "html", html: `<html lang="${lang}">`, message: `default language is "${lang || "missing"}", the content is French` }];
});

const pageTitle = dom(() => {
  const title = document.title.trim();
  return title.length >= 3 && !/^(untitled|document|home|page|create next app)$/i.test(title)
    ? []
    : [{ target: "title", html: `<title>${title}</title>`, message: "the page title is missing or generic" }];
});

const PRESENTATIONAL = ["align", "bgcolor", "background", "cellpadding", "cellspacing", "valign", "hspace", "vspace"];
const presentationalAttrs = dom((attrs) => {
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg")) continue;
    if (["font", "center", "big", "strike", "tt", "basefont", "marquee", "blink"].includes(el.localName)) {
      out.push(window.__rgaa.failure(el, `presentational element <${el.localName}>`));
      continue;
    }
    const found = attrs.filter((a) => el.hasAttribute(a));
    if ((el.hasAttribute("width") || el.hasAttribute("height")) && !["img", "svg", "canvas", "video", "iframe", "input", "object", "embed", "source", "col", "colgroup"].includes(el.localName)) {
      found.push(el.hasAttribute("width") ? "width" : "height");
    }
    if (el.hasAttribute("border") && el.localName !== "table") found.push("border");
    if (found.length) out.push(window.__rgaa.failure(el, `presentational attribute(s): ${found.join(", ")}`));
  }
  return out;
}, PRESENTATIONAL);

const newWindow = dom(() =>
  [...document.querySelectorAll('a[target="_blank"], area[target="_blank"], form[target="_blank"]')]
    .filter((el) => {
      const text = `${el.textContent} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${
        [...(el.getAttribute("aria-describedby") ?? "").split(/\s+/)].map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
      }`;
      return !/nouvel(le)?\s+(onglet|fen[eê]tre)|new\s+(tab|window)/i.test(text);
    })
    .map((el) => window.__rgaa.failure(el, "opens a new window without saying so in its name or description")),
);

const decorativeSvg = dom(() =>
  [...document.querySelectorAll("svg")]
    .filter((svg) => !svg.parentElement?.closest("svg") && window.__rgaa.visible(svg))
    .filter((svg) => {
      const named = svg.getAttribute("role") === "img" && (svg.getAttribute("aria-label") || svg.getAttribute("aria-labelledby") || svg.querySelector(":scope > title"));
      return !named && svg.getAttribute("aria-hidden") !== "true" && !svg.closest('[aria-hidden="true"]');
    })
    .map((svg) => window.__rgaa.failure(svg, 'svg without role="img" and a name, nor aria-hidden="true"')),
);

const figureCaption = dom(() =>
  [...document.querySelectorAll('figure, [role="figure"]')]
    .filter((fig) => fig.querySelector("figcaption") || fig.getAttribute("role") === "figure")
    .filter((fig) => {
      const caption = fig.querySelector("figcaption")?.textContent.trim();
      const name = fig.getAttribute("aria-label") || (fig.getAttribute("aria-labelledby") && document.getElementById(fig.getAttribute("aria-labelledby"))?.textContent);
      return fig.getAttribute("role") === "figure" ? !name : caption && !(fig.getAttribute("aria-label") ?? "").includes(caption);
    })
    .map((fig) => window.__rgaa.failure(fig, 'figure with a caption: needs role="figure" and an aria-label repeating the caption')),
);

export const DATA_TABLES = 'table:not([role="presentation"]):not([role="none"]), [role="table"], [role="grid"]';

const tableTitle = dom((selector) =>
  [...document.querySelectorAll(selector)]
    .filter((t) => window.__rgaa.visible(t))
    .filter((t) => !(t.querySelector(":scope > caption")?.textContent.trim() || t.getAttribute("aria-label") || t.getAttribute("aria-labelledby") || t.getAttribute("title")))
    .map((t) => window.__rgaa.failure(t, "data table without a title (caption, aria-labelledby or aria-label)")),
DATA_TABLES);

const layoutTable = dom(() =>
  [...document.querySelectorAll('table[role="presentation"], table[role="none"]')]
    .filter((t) => window.__rgaa.visible(t))
    .filter((t) => t.querySelector("caption, th, thead, tfoot, [scope], [headers]") || t.hasAttribute("summary"))
    .map((t) => window.__rgaa.failure(t, "layout table with data table markup (caption, th, scope, headers)")),
);

const groupLegend = dom(() => [
  ...[...document.querySelectorAll("fieldset")]
    .filter((f) => window.__rgaa.visible(f))
    .filter((f) => !f.querySelector(":scope > legend")?.textContent.trim())
    .map((f) => window.__rgaa.failure(f, "fieldset without a legend")),
  ...[...document.querySelectorAll('[role="group"], [role="radiogroup"]')]
    .filter((g) => window.__rgaa.visible(g))
    .filter((g) => !(g.getAttribute("aria-label") || g.getAttribute("aria-labelledby")))
    .map((g) => window.__rgaa.failure(g, "group without a name (aria-labelledby or aria-label)")),
]);

const invalidFields = dom(() =>
  [...document.querySelectorAll('[aria-invalid="true"]')]
    .filter((field) => {
      const refs = `${field.getAttribute("aria-describedby") ?? ""} ${field.getAttribute("aria-errormessage") ?? ""}`.trim();
      return !refs || !refs.split(/\s+/).some((id) => document.getElementById(id)?.textContent.trim());
    })
    .map((field) => window.__rgaa.failure(field, "invalid field without an error message linked by aria-describedby or aria-errormessage")),
);

// Status messages (7.5), from what status-observer.js recorded while the steps ran: a live region
// inserted together with its text is never announced (failure); text that appeared outside any
// live region, without the focus moving into it nor a dialog opening, may be a status message
// that is not announced (review).
const statusMessages = dom(() => {
  const events = window.__rgaaStatus?.events() ?? [];
  const failures = [];
  const review = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.kind}|${event.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const quoted = event.text.length > 120 ? `${event.text.slice(0, 117)}...` : event.text;
    const item = window.__rgaa.failure(event.element, "");
    if (event.kind === "region-with-text") {
      failures.push({ ...item, message: `live region inserted with its message, so it is not announced (after step ${event.step + 1}): "${quoted}"` });
      continue;
    }
    const el = event.element;
    const focusedInside = el.isConnected && el.contains(document.activeElement);
    const inDialog = el.isConnected && el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    if (focusedInside || inDialog || review.length >= 20) continue;
    review.push({ ...item, message: `text appeared after step ${event.step + 1} outside any live region (status message?): "${quoted}"` });
  }
  return { failures, review };
});

// --- Layout checks ---------------------------------------------------------------------------

async function settleLayout(page) {
  await page.waitForTimeout(150);
}

async function reflow320(page, { screenshot }) {
  await page.setViewportSize({ width: 320, height: 256 });
  await settleLayout(page);
  if (screenshot) await screenshot("mobile-320");
  const failures = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width + 1) return [];
    const out = [...document.body.querySelectorAll("*")].filter((el) => {
      if (!window.__rgaa.visible(el)) return false;
      const box = el.getBoundingClientRect();
      if (box.right <= width + 1) return false;
      // Content allowed to scroll in its own container (data tables, code...).
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(p).overflowX)) return false;
      }
      return true;
    });
    const outermost = out.filter((el) => !out.some((o) => o !== el && o.contains(el)));
    return outermost.slice(0, 20).map((el) => window.__rgaa.failure(el, `overflows a 320 px viewport (horizontal scroll of ${document.documentElement.scrollWidth}px)`));
  });
  await page.setViewportSize(DESKTOP);
  await settleLayout(page);
  return failures;
}

async function withStyle(page, css, check) {
  const handle = await page.addStyleTag({ content: css });
  await settleLayout(page);
  try {
    return await check();
  } finally {
    await handle.evaluate((node) => node.remove());
    await settleLayout(page);
  }
}

const clippedText = (message) => (page) =>
  page.evaluate((m) => window.__rgaa.clipped().slice(0, 20).map((el) => window.__rgaa.failure(el, m)), message);

const zoom200 = (page) =>
  withStyle(page, "html { font-size: 200% !important; }", () => clippedText("text cut when the font size is doubled")(page));

const textSpacing = (page) =>
  withStyle(
    page,
    "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    () => clippedText("text cut with the WCAG text spacing (line 1.5, letters 0.12em, words 0.16em)")(page),
  );

// Content locked to one orientation: rules under an `orientation` media query that hide or rotate
// elements of the page (a responsive layout change at a width breakpoint is not a lock).
const orientation = dom(() => {
  const out = [];
  const visit = (rules, media) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        visit(rule.cssRules, /orientation/i.test(rule.conditionText) ? rule.conditionText : media);
      } else if (media && rule instanceof CSSStyleRule) {
        const { display, visibility, transform, rotate } = rule.style;
        const locks = display === "none" || visibility === "hidden" || /rotate/i.test(transform) || (rotate && rotate !== "none");
        if (!locks) continue;
        let element = null;
        try {
          element = document.querySelector(rule.selectorText);
        } catch {
          continue;
        }
        if (element) out.push(window.__rgaa.failure(element, `"${rule.selectorText}" is hidden or rotated under @media ${media}`));
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules, null);
    } catch {
      // Cross-origin stylesheet: not readable, axe css-orientation-lock still applies.
    }
  }
  return out;
});

// --- Keyboard and hover (they move the focus) -------------------------------------------------

// Walks the page with Tab and records three verdicts at once. Results are memoized per page so
// that the three scenarios share one walk.
async function keyboardWalk(page) {
  const prepared = await page.evaluate(() => {
    const modal = window.__rgaa.modalRoot();
    if (modal) modal.dataset.rgaaModal = "";
    // Start the walk at the top of the page (of the open modal, where a user's focus is). blur()
    // is not enough: Chromium resumes Tab from the element the steps focused last.
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.dataset.rgaaStart = "";
    (modal ?? document.body).prepend(start);
    start.focus();
    const list = window.__rgaa.tabbables();
    list.forEach((el, i) => {
      el.dataset.rgaaTab = String(i);
      el.dataset.rgaaStyle = window.__rgaa.focusStyle(el);
    });
    return list.length;
  });
  const visits = [];
  // Tab through one full cycle: until the focus has left the page (body / browser UI) twice, the
  // second time after wrapping around (a modal can only be escaped backwards). The page can hold Tab
  // stops tabbables() does not count (Chromium makes scroll containers without focusable content
  // focusable), so the bound leaves room for them before concluding to a trap.
  const max = Math.min(prepared * 2 + 20, 400);
  let exits = 0;
  for (let i = 0; i < max; i += 1) {
    // One exit per move from the page to the outside, however many Tab stops the browser UI takes.
    if (visits.length > 0 && !visits.at(-1).failure && (visits.length === 1 || visits.at(-2).failure)) exits += 1;
    if (exits === 2) break;
    await page.keyboard.press("Tab");
    visits.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        const modal = document.querySelector("[data-rgaa-modal]");
        // Focus outside the keyboard scope: on the body / browser UI, or behind the open modal.
        const outside = !el || el === document.body || (modal !== null && !modal.contains(el));
        if (!el || el === document.body) return { index: null, outside };
        const style = window.__rgaa.focusStyle(el);
        const ring = getComputedStyle(el, ":focus-visible");
        return {
          outside,
          index: el.dataset.rgaaTab ?? null,
          failure: window.__rgaa.failure(el, ""),
          visible: style !== el.dataset.rgaaStyle || (ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0),
          skip: el.localName === "a" && (el.getAttribute("href") ?? "").startsWith("#") && window.__rgaa.visible(el)
            ? document.getElementById(decodeURIComponent(el.getAttribute("href").slice(1))) !== null
            : false,
        };
      }),
    );
  }
  const modal = await page.evaluate(() => {
    const root = document.querySelector("[data-rgaa-modal]");
    const failure = root ? window.__rgaa.failure(root, "") : null;
    delete root?.dataset.rgaaModal;
    document.querySelector("[data-rgaa-start]")?.remove();
    document.querySelectorAll("[data-rgaa-tab]").forEach((el) => {
      delete el.dataset.rgaaTab;
      delete el.dataset.rgaaStyle;
    });
    return failure;
  });
  return { count: prepared, visits, modal };
}

const walks = new WeakMap();
const walk = (page) => {
  if (!walks.has(page)) walks.set(page, keyboardWalk(page));
  return walks.get(page);
};

// Keyboard trap: the focus keeps cycling inside part of the scope and never gets out of it, while
// other controls are never reached. Leaving the scope (body, browser UI) is the normal way out.
async function keyboard(page) {
  const { count, visits, modal } = await walk(page);
  if (count === 0) return [];
  const reached = new Set(visits.map((v) => v.index).filter((i) => i !== null));
  if (reached.size >= count) return [];
  // An open modal that lets the focus out is a broken dialog (modal-focus, 7.1), not a trap.
  if (visits.some((v) => v.outside)) return [];
  if (modal) return [];
  // Focus stuck on a few elements while others were never reached.
  const tail = visits.slice(-Math.min(visits.length, 5)).filter((v) => v.failure);
  const stuck = [...new Map(tail.map((v) => [v.failure.target, v.failure])).values()];
  return stuck.map((f) => ({ ...f, message: `keyboard focus loops here: ${reached.size} of ${count} focusable elements reached with Tab` }));
}

// An open modal dialog must keep the keyboard focus inside it (WAI-ARIA dialog pattern, 7.1).
async function modalFocus(page) {
  const { visits, modal } = await walk(page);
  if (!modal) return [];
  const escaped = visits.find((v) => v.outside && v.failure);
  return escaped
    ? [{ ...modal, message: `the keyboard focus leaves the open modal dialog with Tab (reaches ${escaped.failure.target})` }]
    : [];
}

async function focusVisible(page) {
  const { visits } = await walk(page);
  const seen = new Set();
  return visits
    .filter((v) => v.failure && !v.visible && !seen.has(v.failure.target) && seen.add(v.failure.target))
    .map((v) => ({ ...v.failure, message: "no visible change when this element gets the keyboard focus" }));
}

async function skipLink(page) {
  const { count, visits } = await walk(page);
  if (count === 0) return [];
  // Nothing to bypass when the keyboard already starts in the main content (a login form alone on
  // its page): a skip link is only required in front of repeated blocks (header, navigation).
  const startsInMain = await page.evaluate(() => Boolean(window.__rgaa.tabbables()[0]?.closest('main, [role="main"]')));
  if (startsInMain) return [];
  return visits[0]?.skip
    ? []
    : [{ ...(visits[0]?.failure ?? { target: "body", html: "" }), message: "the first focusable element is not a visible skip link to the main content" }];
}

// Hovers each tabbable element and checks what appears: dismissable with Escape and kept while
// the pointer moves onto it (10.13), and also shown on keyboard focus (12.11).
async function hoverContent(page) {
  const count = await page.evaluate(() => {
    const list = window.__rgaa.tabbables().slice(0, 40);
    list.forEach((el, i) => (el.dataset.rgaaHover = String(i)));
    return list.length;
  });
  const visibleSet = () =>
    page.evaluate(() => [...document.body.querySelectorAll("*")].filter((el) => window.__rgaa.visible(el)).map((el) => window.__rgaa.target(el)));
  const failures = [];
  for (let i = 0; i < count; i += 1) {
    const trigger = page.locator(`[data-rgaa-hover="${i}"]`);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    const before = new Set(await visibleSet());
    if (!(await trigger.isVisible())) continue;
    await trigger.hover({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
    const appeared = (await visibleSet()).filter((t) => !before.has(t));
    if (appeared.length === 0) continue;
    const triggerFailure = await trigger.evaluate((el) => window.__rgaa.failure(el, ""));
    const popup = appeared[0];
    const box = await page.locator(popup).first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await page.waitForTimeout(200);
      if (!(await page.locator(popup).first().isVisible().catch(() => false))) {
        failures.push({ ...triggerFailure, message: "content shown on hover disappears when the pointer moves onto it" });
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if (await page.locator(popup).first().isVisible().catch(() => false)) {
      failures.push({ ...triggerFailure, message: "content shown on hover is not dismissed with Escape" });
    }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await trigger.focus().catch(() => {});
    await page.waitForTimeout(300);
    if (!(await page.locator(popup).first().isVisible().catch(() => false))) {
      failures.push({ ...triggerFailure, message: "content shown on hover is not shown on keyboard focus" });
    }
    await trigger.blur().catch(() => {});
  }
  await page.evaluate(() => document.querySelectorAll("[data-rgaa-hover]").forEach((el) => delete el.dataset.rgaaHover));
  return failures;
}

// Order matters: see the header.
export const SCENARIOS = {
  doctype,
  "duplicate-ids": duplicateIds,
  "lang-fr": langFr,
  "page-title": pageTitle,
  "presentational-attrs": presentationalAttrs,
  "new-window": newWindow,
  "decorative-svg": decorativeSvg,
  "figure-caption": figureCaption,
  "table-title": tableTitle,
  "layout-table": layoutTable,
  "group-legend": groupLegend,
  "invalid-fields": invalidFields,
  "status-messages": statusMessages,
  "reflow-320": reflow320,
  "zoom-200": zoom200,
  "text-spacing": textSpacing,
  orientation,
  keyboard,
  "modal-focus": modalFocus,
  "focus-visible": focusVisible,
  "skip-link": skipLink,
  "hover-content": hoverContent,
};
