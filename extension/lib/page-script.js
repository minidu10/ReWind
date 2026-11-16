// Runs inside the recorded page (injected through the debugger, before any
// page script). Reports user actions, route changes, and visible page changes
// to the extension through a debugger binding.

export const BINDING_NAME = "__rewindEvent";

export function pageScript(win, bindingName) {
  if (win.__rewindInstalled) return;
  win.__rewindInstalled = true;

  const doc = win.document;
  const SENSITIVE = /password|cc-|card|cvc|cvv|one-time-code|secret|token/i;
  const INTERACTIVE = "button, a, [role=button], input, select, textarea, label, summary";

  function send(kind, data) {
    try {
      win[bindingName](JSON.stringify({ kind, ...data }));
    } catch {
      // The debugger detached; nothing to report to
    }
  }

  function clean(text, max) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return { selector: "(unknown)" };

    let selector = el.tagName.toLowerCase();
    if (el.id) {
      selector += "#" + el.id;
    } else if (typeof el.className === "string" && el.className.trim()) {
      selector += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    const name = el.getAttribute("name");
    if (name) selector += '[name="' + name + '"]';

    const text = clean(
      el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title"),
      80
    );
    return text ? { selector, text } : { selector };
  }

  function isSensitive(el) {
    return (
      el.type === "password" ||
      SENSITIVE.test(el.getAttribute("autocomplete") || "") ||
      SENSITIVE.test(el.getAttribute("name") || "") ||
      SENSITIVE.test(el.id || "")
    );
  }

  function target(event) {
    const el = event.target;
    if (!el || el.nodeType !== 1) return null;
    return (el.closest && el.closest(INTERACTIVE)) || el;
  }

  // ---------- User actions ----------

  doc.addEventListener("click", (event) => send("click", describe(target(event))), true);

  doc.addEventListener("submit", (event) => send("submit", describe(event.target)), true);

  doc.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return;

      let value;
      if (isSensitive(el)) value = "[hidden]";
      else if (el.type === "checkbox" || el.type === "radio") value = el.checked ? "checked" : "unchecked";
      else if (el.type === "file") value = "[file]";
      else value = clean(el.value, 100);

      const info = describe(el);
      send("change", { selector: info.selector, value });
    },
    true
  );

  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        send("key", { key: event.key, selector: describe(event.target).selector });
      }
    },
    true
  );

  // ---------- Route changes in single-page apps ----------

  ["pushState", "replaceState"].forEach((method) => {
    const original = win.history[method];
    win.history[method] = function (...args) {
      const before = win.location.href;
      const result = original.apply(this, args);
      if (win.location.href !== before) send("route", { url: win.location.href });
      return result;
    };
  });
  win.addEventListener("popstate", () => send("route", { url: win.location.href }));

  // ---------- Visible page changes ----------

  if (typeof win.MutationObserver !== "function") return;

  const IGNORED_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|TEMPLATE)$/;
  let added = [];
  let removed = [];
  let timer = null;

  function textOf(node) {
    if (node.nodeType === 3) return clean(node.textContent, 120);
    if (node.nodeType === 1 && !IGNORED_TAGS.test(node.tagName)) return clean(node.textContent, 120);
    return "";
  }

  function collect(nodes, into) {
    for (const node of nodes) {
      if (into.length >= 10) return;
      const text = textOf(node);
      if (text && !into.includes(text)) into.push(text);
    }
  }

  function flush() {
    timer = null;
    // Text that was removed and added back in the same batch is a re-render, not a change
    const reallyAdded = added.filter((text) => !removed.includes(text));
    const reallyRemoved = removed.filter((text) => !added.includes(text));
    added = [];
    removed = [];
    if (reallyAdded.length || reallyRemoved.length) {
      send("dom", { added: reallyAdded, removed: reallyRemoved });
    }
  }

  new win.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      collect(mutation.addedNodes, added);
      collect(mutation.removedNodes, removed);
    }
    if (!timer && (added.length || removed.length)) timer = win.setTimeout(flush, 400);
  }).observe(doc, { childList: true, subtree: true });
}

// The source sent to Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate
export const PAGE_SCRIPT = `(${pageScript.toString()})(window, ${JSON.stringify(BINDING_NAME)});`;
