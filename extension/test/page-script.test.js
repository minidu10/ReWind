import assert from "node:assert/strict";
import { test } from "node:test";
import { BINDING_NAME, PAGE_SCRIPT, pageScript } from "../lib/page-script.js";

// A minimal stand-in for the browser window: just what the page script touches.
function fakeWindow({ mutationObserver = true } = {}) {
  const sent = [];
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  let observerCallback = null;

  const win = {
    location: { href: "http://localhost:3000/" },
    document: {
      addEventListener: (type, listener) => (docListeners[type] = listener)
    },
    addEventListener: (type, listener) => (winListeners[type] = listener),
    history: {
      pushState(_state, _title, url) {
        if (url !== undefined) win.location.href = new URL(url, win.location.href).href;
      },
      replaceState(_state, _title, url) {
        if (url !== undefined) win.location.href = new URL(url, win.location.href).href;
      }
    },
    setTimeout: (callback) => timers.push(callback),
    [BINDING_NAME]: (payload) => sent.push(JSON.parse(payload))
  };

  if (mutationObserver) {
    win.MutationObserver = class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe() {}
    };
  }

  return {
    win,
    sent,
    fire: (type, event) => docListeners[type](event),
    fireWindow: (type) => winListeners[type]({}),
    mutate: (addedNodes, removedNodes = []) => observerCallback([{ addedNodes, removedNodes }]),
    runTimers: () => timers.splice(0).forEach((callback) => callback()),
    pendingTimers: () => timers.length
  };
}

function element(tag, { id = "", className = "", attrs = {}, closest = null, ...props } = {}) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    className,
    getAttribute: (name) => attrs[name] ?? null,
    closest: () => closest,
    ...props
  };
  return el;
}

const textNode = (text) => ({ nodeType: 3, textContent: text });

function install(options) {
  const page = fakeWindow(options);
  pageScript(page.win, BINDING_NAME);
  return page;
}

// ---------- Clicks ----------

test("reports a click on the closest interactive element", () => {
  const { sent, fire } = install();
  const button = element("button", { id: "buy", innerText: "  Add to\n cart " });
  const icon = element("span", { className: "icon", closest: button });

  fire("click", { target: icon });

  assert.deepEqual(sent, [{ kind: "click", selector: "button#buy", text: "Add to cart" }]);
});

test("builds a selector from classes and name when there is no id", () => {
  const { sent, fire } = install();

  fire("click", { target: element("div", { className: " card  card--wide extra " }) });
  fire("click", { target: element("input", { className: "field", attrs: { name: "email", placeholder: "you@example.com" } }) });
  fire("click", { target: element("a", { attrs: { "aria-label": "Close", title: "ignored" }, innerText: "×" }) });

  assert.deepEqual(sent, [
    { kind: "click", selector: "div.card.card--wide" },
    { kind: "click", selector: 'input.field[name="email"]', text: "you@example.com" },
    { kind: "click", selector: "a", text: "Close" }
  ]);
});

test("survives clicks on things that are not elements", () => {
  const { sent, fire } = install();
  fire("click", { target: { nodeType: 9 } }); // the document itself
  fire("click", { target: element("svg", { className: { baseVal: "icon" } }) }); // SVG className is not a string
  assert.deepEqual(sent, [
    { kind: "click", selector: "(unknown)" },
    { kind: "click", selector: "svg" }
  ]);
});

test("cuts long element text", () => {
  const { sent, fire } = install();
  fire("click", { target: element("p", { innerText: "x".repeat(500) }) });
  assert.equal(sent[0].text.length, 80);
});

// ---------- Changes ----------

test("reports input changes with the new value", () => {
  const { sent, fire } = install();

  fire("change", { target: element("input", { id: "qty", type: "number", value: " 3 " }) });
  fire("change", { target: element("input", { attrs: { name: "terms" }, type: "checkbox", checked: true }) });
  fire("change", { target: element("input", { attrs: { name: "plan" }, type: "radio", checked: false }) });
  fire("change", { target: element("input", { id: "avatar", type: "file", value: "C:\\fakepath\\me.png" }) });
  fire("change", { target: element("select", { id: "country", type: "select-one", value: "LK" }) });

  assert.deepEqual(sent, [
    { kind: "change", selector: "input#qty", value: "3" },
    { kind: "change", selector: 'input[name="terms"]', value: "checked" },
    { kind: "change", selector: 'input[name="plan"]', value: "unchecked" },
    { kind: "change", selector: "input#avatar", value: "[file]" },
    { kind: "change", selector: "select#country", value: "LK" }
  ]);
});

test("never sends password, card, or token values", () => {
  const { sent, fire } = install();
  const typed = "do-not-record-this";

  const sensitive = [
    element("input", { id: "pw", type: "password", value: typed }),
    element("input", { type: "text", value: typed, attrs: { autocomplete: "cc-number" } }),
    element("input", { type: "text", value: typed, attrs: { autocomplete: "one-time-code" } }),
    element("input", { type: "text", value: typed, attrs: { name: "cardNumber" } }),
    element("input", { type: "text", value: typed, attrs: { name: "cvv" } }),
    element("input", { id: "api-token", type: "text", value: typed }),
    element("input", { id: "clientSecret", type: "text", value: typed }),
    element("input", { type: "text", value: typed, attrs: { name: "new_password" } })
  ];
  for (const el of sensitive) fire("change", { target: el });

  assert.equal(sent.length, sensitive.length);
  for (const message of sent) assert.equal(message.value, "[hidden]");
  assert.equal(JSON.stringify(sent).includes(typed), false);
});

test("cuts long values", () => {
  const { sent, fire } = install();
  fire("change", { target: element("textarea", { id: "bio", type: "textarea", value: "y".repeat(5000) }) });
  assert.equal(sent[0].value.length, 100);
});

// ---------- Submit and keys ----------

test("reports form submits", () => {
  const { sent, fire } = install();
  fire("submit", { target: element("form", { id: "checkout" }) });
  assert.deepEqual(sent, [{ kind: "submit", selector: "form#checkout" }]);
});

test("reports Enter and Escape, and no other keys", () => {
  const { sent, fire } = install();
  const input = element("input", { id: "search" });

  for (const key of ["a", "Enter", "Tab", "Escape", "1", " "]) fire("keydown", { key, target: input });

  assert.deepEqual(sent, [
    { kind: "key", key: "Enter", selector: "input#search" },
    { kind: "key", key: "Escape", selector: "input#search" }
  ]);
});

// ---------- Routes ----------

test("reports route changes from pushState, replaceState, and popstate", () => {
  const { win, sent, fireWindow } = install();

  win.history.pushState({}, "", "/cart");
  win.history.replaceState({}, "", "/cart?step=2");
  win.history.replaceState({ scroll: 10 }, ""); // same URL: not a route change
  win.history.pushState({}, "", "/cart?step=2"); // same URL again
  win.location.href = "http://localhost:3000/";
  fireWindow("popstate");

  assert.deepEqual(sent, [
    { kind: "route", url: "http://localhost:3000/cart" },
    { kind: "route", url: "http://localhost:3000/cart?step=2" },
    { kind: "route", url: "http://localhost:3000/" }
  ]);
});

test("keeps the return value and `this` of the original history methods", () => {
  const page = fakeWindow();
  let receiver = null;
  page.win.history.pushState = function () {
    receiver = this;
    return "original result";
  };
  pageScript(page.win, BINDING_NAME);

  assert.equal(page.win.history.pushState({}, "", "/x"), "original result");
  assert.equal(receiver, page.win.history);
});

// ---------- Page changes ----------

test("summarises added and removed text after a short delay", () => {
  const { sent, mutate, runTimers, pendingTimers } = install();

  mutate([element("div", { textContent: "  Out of\n stock " }), textNode("Try again")], [textNode("Loading…")]);
  mutate([textNode("Try again")]); // duplicate text in the same batch
  assert.equal(sent.length, 0);
  assert.equal(pendingTimers(), 1);

  runTimers();
  assert.deepEqual(sent, [{ kind: "dom", added: ["Out of stock", "Try again"], removed: ["Loading…"] }]);
});

test("ignores re-renders, scripts, styles, and empty nodes", () => {
  const { sent, mutate, runTimers, pendingTimers } = install();

  // Removed and added back: a re-render
  mutate([textNode("Total: 12")], [textNode("Total: 12")]);
  runTimers();

  mutate([element("script", { textContent: "console.log(1)" }), element("style", { textContent: "a{}" }), textNode("   "), { nodeType: 8, textContent: "comment" }]);
  assert.equal(pendingTimers(), 0);

  assert.equal(sent.length, 0);
});

test("keeps at most ten items per batch and cuts long text", () => {
  const { sent, mutate, runTimers } = install();

  mutate(Array.from({ length: 30 }, (_, i) => textNode(`row ${i} ${"z".repeat(300)}`)));
  runTimers();

  assert.equal(sent[0].added.length, 10);
  assert.equal(sent[0].added[0].length, 120);
});

test("starts a new batch after each flush", () => {
  const { sent, mutate, runTimers } = install();

  mutate([textNode("first")]);
  runTimers();
  mutate([textNode("second")]);
  runTimers();

  assert.deepEqual(
    sent.map((message) => message.added),
    [["first"], ["second"]]
  );
});

// ---------- Installation ----------

test("installs only once per page", () => {
  const page = fakeWindow();
  pageScript(page.win, BINDING_NAME);
  pageScript(page.win, BINDING_NAME);

  page.fire("click", { target: element("button", { id: "once" }) });
  page.win.history.pushState({}, "", "/once");

  assert.equal(page.sent.length, 2); // one click, one route: nothing doubled
});

test("works without MutationObserver", () => {
  const { sent, fire } = install({ mutationObserver: false });
  fire("click", { target: element("button", { id: "ok" }) });
  assert.equal(sent.length, 1);
});

test("does not throw when the binding is gone (debugger detached)", () => {
  const { win, fire } = install();
  delete win[BINDING_NAME];
  assert.doesNotThrow(() => fire("click", { target: element("button") }));
});

test("the injected source is self-contained and installs on `window`", () => {
  const page = fakeWindow();
  // The same string Chrome evaluates in the page
  new Function("window", PAGE_SCRIPT)(page.win);

  assert.equal(page.win.__rewindInstalled, true);
  page.fire("click", { target: element("button", { id: "injected" }) });
  assert.deepEqual(page.sent, [{ kind: "click", selector: "button#injected" }]);
});
