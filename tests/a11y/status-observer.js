// Installed in every page before its own scripts (addInitScript, MAIR-318, criterion 7.5).
// Records what appears in the DOM once the steps of the state start (window.__rgaaStatus.mark()
// is called before each step, stop() once they are over), so that the status-messages scenario can tell:
//   - a live region inserted together with its text: assistive technologies never announce it;
//   - text that appeared after an action outside any live region: a status message candidate.
// Transient messages (toasts that close themselves) are recorded even if they are gone later.
(() => {
  const LIVE = '[role="status"], [role="alert"], [role="log"], [role="timer"], [role="marquee"], [aria-live="polite"], [aria-live="assertive"], output';
  const state = { step: null, events: [] };

  const text = (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const liveIn = (el) => (el.matches?.(LIVE) ? [el] : [...(el.querySelectorAll?.(LIVE) ?? [])]);

  function onMutations(records) {
    if (state.step === null) return;
    // Elements added to the DOM, and elements whose text changed (text node added or edited).
    const added = new Set();
    const changed = new Set();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) added.add(node);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement) changed.add(node.parentElement);
      }
      if (record.type === "characterData" && record.target.parentElement) changed.add(record.target.parentElement);
    }
    const all = [...added, ...changed];
    // Outermost elements of this batch only.
    const roots = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    for (const el of roots) {
      if (!el.isConnected || !text(el) || el.closest("head, script, style, noscript, template")) continue;
      // Only a region that is itself new can have been inserted with its text.
      const newRegions = added.has(el) ? liveIn(el).filter((region) => text(region)) : [];
      if (newRegions.length > 0) {
        for (const region of newRegions) state.events.push({ kind: "region-with-text", step: state.step, element: region, text: text(region) });
        continue;
      }
      if (el.closest(LIVE)) continue; // Text written into a region that was already there: announced.
      state.events.push({ kind: "text", step: state.step, element: el, text: text(el) });
    }
  }

  const start = () => {
    new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);

  window.__rgaaStatus = {
    mark(step) {
      state.step = step;
    },
    // Called once the steps are over: the engine's own injections must not be recorded.
    stop() {
      state.step = null;
    },
    events: () => state.events,
  };
})();
