import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatEvent, formatEvents, formatFrame, formatLocation, relativeTime, shortUrl } from "../lib/format.js";

const NOW = 100_000;
const PAGE = "http://localhost:3000/cart";
const line = (type, data, { id = 57, ts = NOW - 9600 } = {}) => formatEvent({ id, ts, type, data }, { now: NOW, pageUrl: PAGE });

test("formats a failed request like the README example", () => {
  const text = line("network", { method: "POST", url: "http://localhost:3000/api/cart", resourceType: "Fetch", durationMs: 120, status: 500 });
  assert.equal(text, "#57 [-9.6s] POST /api/cart → 500 (120ms)");
});

test("formats relative times", () => {
  assert.equal(relativeTime(NOW - 9600, NOW), "-9.6s");
  assert.equal(relativeTime(NOW, NOW), "-0.0s");
  assert.equal(relativeTime(NOW - 125_000, NOW), "-125.0s");
  assert.equal(relativeTime(NOW + 500, NOW), "+0.5s");
});

test("formats durations", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(120.4), "120ms");
  assert.equal(formatDuration(9999), "9999ms");
  assert.equal(formatDuration(12_340), "12.3s");
});

test("shows the path for the page's own origin and the host for others", () => {
  assert.equal(shortUrl("http://localhost:3000/api/cart?id=7", PAGE), "/api/cart?id=7");
  assert.equal(shortUrl("https://api.example.com/v1/pay", PAGE), "api.example.com/v1/pay");
  assert.equal(shortUrl("http://localhost:8080/api", PAGE), "localhost:8080/api");
  assert.equal(shortUrl("http://localhost:3000/api"), "localhost:3000/api");
  assert.equal(shortUrl("not a url", PAGE), "not a url");
  assert.equal(shortUrl("http://localhost:3000/api", "not a url"), "localhost:3000/api");
});

test("formats network failures and cancellations", () => {
  const base = { method: "GET", url: "http://localhost:3000/api/items", resourceType: "Fetch", durationMs: 30 };
  assert.equal(line("network", { ...base, error: "net::ERR_CONNECTION_REFUSED" }), "#57 [-9.6s] GET /api/items ✗ net::ERR_CONNECTION_REFUSED (30ms)");
  assert.equal(line("network", { ...base, error: "net::ERR_ABORTED", canceled: true }), "#57 [-9.6s] GET /api/items ✗ canceled (30ms)");
  assert.equal(line("network", { ...base, status: 200 }), "#57 [-9.6s] GET /api/items → 200 (30ms)");
});

test("formats user actions", () => {
  assert.equal(line("action", { kind: "click", selector: "button#buy", text: "Add to cart" }), '#57 [-9.6s] click button#buy "Add to cart"');
  assert.equal(line("action", { kind: "change", selector: 'input[name="qty"]', value: "3" }), '#57 [-9.6s] change input[name="qty"] = "3"');
  assert.equal(line("action", { kind: "change", selector: "input#q", value: "" }), '#57 [-9.6s] change input#q = ""');
  assert.equal(line("action", { kind: "submit", selector: "form#checkout" }), "#57 [-9.6s] submit form#checkout");
  assert.equal(line("action", { kind: "key", selector: "input#search", key: "Enter" }), "#57 [-9.6s] key Enter in input#search");
});

test("formats navigation", () => {
  assert.equal(line("navigation", { kind: "load", url: "http://localhost:3000/cart" }), "#57 [-9.6s] page load localhost:3000/cart");
  assert.equal(line("navigation", { kind: "route", url: "http://localhost:3000/checkout?step=2" }), "#57 [-9.6s] route change → /checkout?step=2");
});

test("formats console output, with the location for errors", () => {
  assert.equal(line("console", { level: "log", text: "cart loaded" }), "#57 [-9.6s] console.log: cart loaded");
  assert.equal(
    line("console", { level: "error", text: "Failed to save", stack: [{ fn: "save", url: "http://localhost:3000/assets/app.js", line: 10, col: 5 }] }),
    "#57 [-9.6s] console.error: Failed to save (/assets/app.js:10:5)"
  );
});

test("formats exceptions and prefers the mapped source location", () => {
  const frame = { fn: "render", url: "http://localhost:3000/assets/app.js", line: 1, col: 120 };
  assert.equal(
    line("exception", { message: "TypeError: x is undefined", stack: [frame] }),
    "#57 [-9.6s] EXCEPTION TypeError: x is undefined (/assets/app.js:1:120)"
  );
  assert.equal(
    line("exception", { message: "TypeError: x is undefined", stack: [{ ...frame, source: { file: "src/Cart.jsx", line: 42, col: 7 } }] }),
    "#57 [-9.6s] EXCEPTION TypeError: x is undefined (src/Cart.jsx:42:7)"
  );
  assert.equal(line("exception", { message: "boom", stack: [] }), "#57 [-9.6s] EXCEPTION boom");
});

test("formats browser log entries and page changes", () => {
  assert.equal(line("log", { level: "error", source: "security", text: "Mixed Content: blocked" }), "#57 [-9.6s] browser error [security]: Mixed Content: blocked");
  assert.equal(line("dom", { added: ["Out of stock"], removed: ["Loading…"] }), '#57 [-9.6s] page changed: +"Out of stock" -"Loading…"');
});

test("keeps every event on one line and cuts long text", () => {
  const text = line("console", { level: "log", text: `first\nsecond\t\tthird ${"x".repeat(1000)}` });
  assert.equal(text.includes("\n"), false);
  assert.ok(text.startsWith("#57 [-9.6s] console.log: first second third xxx"));
  assert.ok(text.length < 340);
  assert.ok(text.endsWith("…"));
});

test("does not fail on an unknown event type", () => {
  assert.equal(line("custom", { a: 1 }), '#57 [-9.6s] custom {"a":1}');
});

test("formats a list of events, one per line", () => {
  const events = [
    { id: 1, ts: NOW - 2000, type: "action", data: { kind: "click", selector: "button#buy" } },
    { id: 2, ts: NOW - 1000, type: "console", data: { level: "error", text: "broken" } }
  ];
  assert.equal(formatEvents(events, { now: NOW, pageUrl: PAGE }), "#1 [-2.0s] click button#buy\n#2 [-1.0s] console.error: broken");
});

test("formats stack frames with the source line when it is known", () => {
  const frame = { fn: "", url: "http://localhost:3000/assets/app.js", line: 1, col: 120 };
  assert.equal(formatLocation(null), "");
  assert.equal(formatFrame(frame, PAGE), "at (anonymous) (/assets/app.js:1:120)");
  assert.equal(
    formatFrame({ ...frame, fn: "render", source: { file: "src/Cart.jsx", line: 42, col: 7, code: "items.map(renderItem)" } }, PAGE),
    "at render (src/Cart.jsx:42:7)  [bundle: /assets/app.js:1:120]\n      > items.map(renderItem)"
  );
});
