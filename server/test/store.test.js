import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, isCodeUpdate, isError } from "../lib/store.js";

function setup(options = {}) {
  const clock = { now: 100_000 };
  const store = new Store({ now: () => clock.now, ...options });
  return { store, clock };
}

const consoleEvent = (ts, level, text) => ({ ts, type: "console", data: { level, text } });
const network = (ts, extra) => ({ ts, type: "network", data: { method: "GET", url: "http://localhost/api", resourceType: "Fetch", durationMs: 5, ...extra } });
const load = (ts, url = "http://localhost/") => ({ ts, type: "navigation", data: { kind: "load", url } });

test("assigns increasing numeric ids", () => {
  const { store } = setup();
  const first = store.add([consoleEvent(99_000, "log", "a"), consoleEvent(99_100, "log", "b")]);
  const second = store.add([consoleEvent(99_200, "log", "c")]);

  assert.deepEqual(first.map((event) => event.id), [1, 2]);
  assert.deepEqual(second.map((event) => event.id), [3]);
  assert.equal(store.get(2).data.text, "b");
  assert.equal(store.get(99), null);
});

test("keeps events sorted by time even when they arrive late", () => {
  const { store } = setup();
  store.add([consoleEvent(99_500, "log", "second"), consoleEvent(99_900, "log", "fourth")]);
  // A request is reported when it finishes but stamped with when it started
  store.add([network(99_100, { status: 200 }), consoleEvent(99_700, "log", "third")]);

  assert.deepEqual(store.all().map((event) => event.ts), [99_100, 99_500, 99_700, 99_900]);
  assert.deepEqual(store.all().map((event) => event.id), [3, 1, 4, 2]);
});

test("keeps arrival order for events with the same timestamp", () => {
  const { store } = setup();
  store.add([consoleEvent(99_000, "log", "a"), consoleEvent(99_000, "log", "b"), consoleEvent(99_000, "log", "c")]);
  assert.deepEqual(store.all().map((event) => event.data.text), ["a", "b", "c"]);
});

test("drops events older than the window", () => {
  const { store, clock } = setup({ windowMs: 10_000 });
  store.add([consoleEvent(95_000, "log", "old"), consoleEvent(99_000, "log", "new")]);
  assert.equal(store.size, 2);

  clock.now = 106_000; // "old" is now 11s old
  assert.deepEqual(store.all().map((event) => event.data.text), ["new"]);
  assert.equal(store.get(1), null);

  clock.now = 200_000;
  assert.equal(store.size, 0);
});

test("does not keep events that are already too old when they arrive", () => {
  const { store } = setup({ windowMs: 10_000 });
  store.add([consoleEvent(50_000, "log", "ancient")]);
  assert.equal(store.size, 0);
});

test("keeps at most maxEvents, dropping the oldest", () => {
  const { store } = setup({ maxEvents: 3 });
  store.add([1, 2, 3, 4, 5].map((n) => consoleEvent(99_000 + n, "log", `line ${n}`)));
  assert.deepEqual(store.all().map((event) => event.data.text), ["line 3", "line 4", "line 5"]);
});

test("defaults to five minutes and 5000 events", () => {
  const store = new Store();
  assert.equal(store.windowMs, 300_000);
  assert.equal(store.maxEvents, 5000);
});

test("pulls timestamps from a fast clock back to now", () => {
  const { store } = setup();
  const [event] = store.add([consoleEvent(999_999, "log", "from the future")]);
  assert.equal(event.ts, 100_000);
});

test("clear removes everything but ids keep counting", () => {
  const { store } = setup();
  store.add([consoleEvent(99_000, "log", "a")]);
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.add([consoleEvent(99_500, "log", "b")])[0].id, 2);
});

test("range returns events between two times, inclusive", () => {
  const { store } = setup();
  store.add([1, 2, 3, 4].map((n) => consoleEvent(99_000 + n * 100, "log", `${n}`)));
  assert.deepEqual(store.range(99_200, 99_300).map((event) => event.data.text), ["2", "3"]);
  assert.deepEqual(store.range(99_300).map((event) => event.data.text), ["3", "4"]);
});

test("knows which events are errors", () => {
  assert.equal(isError({ type: "exception", data: { message: "x", stack: [] } }), true);
  assert.equal(isError(consoleEvent(1, "error", "x")), true);
  assert.equal(isError(consoleEvent(1, "warn", "x")), false);
  assert.equal(isError({ type: "log", data: { level: "error", source: "security", text: "x" } }), true);
  assert.equal(isError({ type: "log", data: { level: "warn", source: "deprecation", text: "x" } }), false);
  assert.equal(isError(network(1, { status: 200 })), false);
  assert.equal(isError(network(1, { status: 304 })), false);
  assert.equal(isError(network(1, { status: 404 })), true);
  assert.equal(isError(network(1, { status: 500 })), true);
  assert.equal(isError(network(1, { error: "net::ERR_CONNECTION_REFUSED" })), true);
  assert.equal(isError(network(1, { error: "net::ERR_ABORTED", canceled: true })), false);
  assert.equal(isError({ type: "action", data: { kind: "click", selector: "a" } }), false);
  assert.equal(isError({ type: "dom", data: { added: ["Error!"], removed: [] } }), false);
});

test("finds errors, optionally only those after a time", () => {
  const { store } = setup();
  store.add([
    consoleEvent(99_000, "error", "early"),
    consoleEvent(99_100, "log", "fine"),
    network(99_200, { status: 500 }),
    { ts: 99_300, type: "exception", data: { message: "TypeError", stack: [] } }
  ]);

  assert.deepEqual(store.errors().map((event) => event.id), [1, 3, 4]);
  assert.deepEqual(store.errors(99_200).map((event) => event.id), [3, 4]);
});

test("recognises page loads and hot updates as code updates", () => {
  assert.equal(isCodeUpdate(load(1)), true);
  assert.equal(isCodeUpdate({ type: "navigation", data: { kind: "route", url: "http://localhost/cart" } }), false);

  const updates = [
    "[vite] hot updated: /src/App.jsx",
    "[vite] css hot updated: /src/index.css",
    "[vite] page reload src/main.jsx",
    "[HMR] Updated modules:",
    "[HMR] App is up to date.",
    "[webpack-dev-server] App hot update...",
    "[webpack-dev-server] App updated. Recompiling...",
    "[Fast Refresh] rebuilding",
    "[Fast Refresh] done in 132ms"
  ];
  for (const text of updates) assert.equal(isCodeUpdate(consoleEvent(1, "log", text)), true, text);

  const others = ["[vite] connecting...", "[vite] connected.", "hot updated my profile", "[HMR] Waiting for update signal from WDS...", "Download the React DevTools"];
  for (const text of others) assert.equal(isCodeUpdate(consoleEvent(1, "log", text)), false, text);

  assert.equal(isCodeUpdate({ type: "dom", data: { added: ["[vite] hot updated: /x"], removed: [] } }), false);
});

test("finds the last code update", () => {
  const { store } = setup();
  assert.equal(store.lastCodeUpdate(), null);

  store.add([load(99_000), consoleEvent(99_100, "error", "bug"), consoleEvent(99_500, "log", "[vite] hot updated: /src/Cart.jsx"), consoleEvent(99_600, "log", "after")]);
  assert.equal(store.lastCodeUpdate().id, 3);

  store.add([load(99_800)]);
  assert.equal(store.lastCodeUpdate().id, 5);
});

test("counts events by type", () => {
  const { store } = setup();
  store.add([load(99_000), consoleEvent(99_100, "log", "a"), consoleEvent(99_200, "log", "b"), network(99_300, { status: 200 })]);
  assert.deepEqual(store.counts(), { navigation: 1, console: 2, network: 1 });
});
