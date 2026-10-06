// Injected in the page under test (addScriptTag) before the checks run (MAIR-318).
// Plain browser script: no imports, everything hangs off window.__rgaa.
(() => {
  const ID_REF_ATTRS = [
    "for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns",
    "aria-activedescendant", "aria-errormessage", "aria-details", "aria-flowto", "headers", "list", "form",
  ];

  function target(element) {
    if (!(element instanceof Element)) return "";
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.localName;
      const id = node.getAttribute("id");
      if (id && !/[:«»]/.test(id) && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
        parts.unshift(`${part}#${CSS.escape(id)}`);
        break;
      }
      const siblings = node.parentElement ? [...node.parentElement.children].filter((s) => s.localName === node.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  }

  function html(element) {
    const outer = element.outerHTML ?? "";
    const open = outer.slice(0, outer.indexOf(">") + 1);
    return (open.length > 0 && open.length < 300 ? open : outer.slice(0, 300)).replace(/\s+/g, " ");
  }

  function failure(element, message) {
    return { target: target(element), html: html(element), message };
  }

  function visible(element) {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  const TABBABLE = [
    "a[href]", "area[href]", "button", "input:not([type=hidden])", "select", "textarea", "iframe",
    "summary", "[tabindex]", "[contenteditable]:not([contenteditable=false])", "audio[controls]", "video[controls]",
  ].join(",");

  // Keyboard-reachable elements, inside the open modal dialog when there is one (a modal
  // keeps the focus inside on purpose: that is not a keyboard trap).
  function tabbables() {
    const modal = [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].filter(visible).pop();
    const root = modal ?? document;
    return [...root.querySelectorAll(TABBABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && visible(el) && !el.closest("[inert]"),
    );
  }

  const FOCUS_STYLE = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderTopColor",
    "borderBottomColor", "borderBottomWidth", "backgroundColor", "color", "textDecorationLine"];

  function focusStyle(element) {
    const style = getComputedStyle(element);
    return FOCUS_STYLE.map((p) => style[p]).join("|");
  }

  // Elements whose content is cut by their own box (overflow hidden/clip), for zoom and spacing.
  function clipped() {
    const out = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (!visible(element) || !element.textContent.trim()) continue;
      const style = getComputedStyle(element);
      const hidesX = ["hidden", "clip"].includes(style.overflowX);
      const hidesY = ["hidden", "clip"].includes(style.overflowY);
      const overX = hidesX && element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== "ellipsis";
      const overY = hidesY && element.scrollHeight > element.clientHeight + 1;
      // sr-only / visually-hidden text is clipped on purpose.
      if ((overX || overY) && element.clientWidth > 1 && element.clientHeight > 1) out.push(element);
    }
    // Keep the innermost elements only.
    return out.filter((el) => !out.some((other) => other !== el && el.contains(other)));
  }

  // Generated ids (React useId, Radix, Headless UI...) and Next.js build hashes change between
  // builds and runs: they are rewritten to stable placeholders, in document order.
  const GENERATED_ID = /^(:[^:]+:|«[^»]+»|_R_.*|radix-.*|headlessui-.*|react-aria\d*-.*)$/;

  function normalizedHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, link[rel=preload], link[rel=modulepreload], next-route-announcer")
      .forEach((n) => n.remove());
    const ids = new Map();
    const stable = (id) => {
      if (!GENERATED_ID.test(id)) return id;
      if (!ids.has(id)) ids.set(id, `gen-${ids.size + 1}`);
      return ids.get(id);
    };
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      for (const name of ["class", "style", "nonce"]) node.removeAttribute(name);
      for (const attr of [...node.attributes]) {
        if (attr.name.startsWith("data-next") || attr.name.startsWith("data-precedence")) node.removeAttribute(attr.name);
      }
      if (node.hasAttribute("id")) node.setAttribute("id", stable(node.getAttribute("id")));
      for (const name of ID_REF_ATTRS) {
        if (node.hasAttribute(name)) node.setAttribute(name, node.getAttribute(name).split(/\s+/).map(stable).join(" "));
      }
      for (const name of ["src", "href", "srcset"]) {
        if (node.hasAttribute(name)) {
          node.setAttribute(name, node.getAttribute(name).replace(/\/_next\/static\/[^/]+\//g, "/_next/static/<build>/")
            .replace(/([?&](dpl|v|_rsc)=)[^&"\s]+/g, "$1<build>"));
        }
      }
      const sorted = [...node.attributes].map((a) => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b));
      for (const [name] of sorted) node.removeAttribute(name);
      for (const [name, value] of sorted) node.setAttribute(name, value);
    }
    return `<!doctype ${document.doctype?.name ?? "none"}>\n${clone.outerHTML.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ")}`;
  }

  window.__rgaa = { target, html, failure, visible, tabbables, focusStyle, clipped, normalizedHtml };
})();
