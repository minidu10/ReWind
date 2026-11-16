import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Bridge } from "../lib/bridge.js";
import { Store } from "../lib/store.js";
import { EXTENSION_ID, connectExtension, connectionRefusal, sleep, waitFor } from "./helpers.js";

const PAGE = { url: "http://localhost:3000/cart", title: "Cart" };
const OTHER_EXTENSION = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const open = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((bridge) => bridge.close()));
});

// A bridge on a free port (port 0 = let the OS choose)
async function setup(options = {}) {
  const store = new Store();
  const bridge = new Bridge({ store, port: 0, ...options });
  open.push(bridge);
  await bridge.start();
  return { store, bridge, port: bridge.port };
}

const logEvent = (text, ts = Date.now()) => ({ ts, type: "console", data: { level: "log", text } });

test("listens on 127.0.0.1 only", async () => {
  const { bridge } = await setup();
  assert.equal(bridge.listening, true);
  assert.equal(bridge.server.address().address, "127.0.0.1");
});

test("accepts the extension and stores its events", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);

  extension.send({ type: "HELLO", recording: true, page: PAGE });
  extension.send({ type: "EVENTS", events: [logEvent("one"), logEvent("two")] });
  await waitFor(() => store.size === 2, { what: "events" });

  assert.equal(bridge.connected, true);
  assert.equal(bridge.recording, true);
  assert.deepEqual(bridge.page, PAGE);
  assert.deepEqual(store.all().map((event) => event.data.text), ["one", "two"]);
  assert.equal(bridge.rejectedMessages, 0);
});

test("rejects connections that do not come from a Chrome extension", async () => {
  const { bridge, port } = await setup();

  const origins = [
    null, // no Origin header: a script or another program on this machine
    "http://localhost:3000", // a web page
    "https://evil.example.com",
    "chrome-extension://short",
    `chrome-extension://${EXTENSION_ID}.evil.example.com`,
    `moz-extension://${EXTENSION_ID}`,
    "null"
  ];
  for (const origin of origins) {
    assert.equal(await connectionRefusal(port, origin), 401, `origin ${origin}`);
  }
  assert.equal(bridge.connected, false);
});

test("accepts only the configured extension when REWIND_EXTENSION_ID is set", async () => {
  const { bridge, port } = await setup({ extensionId: EXTENSION_ID });

  assert.equal(await connectionRefusal(port, OTHER_EXTENSION), 401);
  assert.equal(bridge.connected, false);

  await connectExtension(port);
  await waitFor(() => bridge.connected, { what: "connection" });
});

test("ignores messages that are not valid", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);

  const bad = [
    "not json",
    "null",
    "[]",
    '{"type":"UNKNOWN"}',
    { type: "HELLO" }, // recording is missing
    { type: "HELLO", recording: "yes" },
    { type: "SESSION_START", page: { url: 5 } },
    { type: "EVENTS" },
    { type: "EVENTS", events: "many" },
    { type: "RESPONSE", id: "1", result: {} },
    { type: "RESPONSE", id: 12345, result: {} } // nobody asked
  ];
  for (const message of bad) extension.send(message);
  extension.socket.send(Buffer.from([1, 2, 3])); // binary

  extension.send({ type: "EVENTS", events: [logEvent("still works")] });
  await waitFor(() => store.size === 1, { what: "the valid event" });

  assert.equal(bridge.rejectedMessages, bad.length + 1);
  assert.equal(bridge.recording, true);
  assert.equal(bridge.connected, true);
});

test("drops invalid events but keeps the valid ones from the same batch", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);

  extension.send({
    type: "EVENTS",
    events: [
      logEvent("good"),
      { ts: Date.now(), type: "console", data: { level: "shout", text: "bad level" } },
      { ts: Date.now(), type: "teleport", data: {} },
      { ts: "yesterday", type: "console", data: { level: "log", text: "bad time" } },
      { ts: Date.now(), type: "network", data: { method: "GET" } },
      { ts: Date.now(), type: "exception", data: { message: "no stack" } },
      { type: "console", data: { level: "log", text: "no time" } },
      null,
      "event",
      { ts: Date.now(), type: "action", data: { kind: "click", selector: "button#buy", injected: "<script>" } }
    ]
  });
  await waitFor(() => store.size === 2, { what: "the valid events" });

  assert.equal(bridge.rejectedMessages, 1);
  assert.deepEqual(store.all().map((event) => event.type), ["console", "action"]);
  // Fields that are not part of the protocol are stripped
  assert.deepEqual(store.all()[1].data, { kind: "click", selector: "button#buy" });
});

test("accepts every event type in the protocol", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);
  const ts = Date.now();
  const frame = { fn: "render", url: "http://localhost:3000/app.js", line: 1, col: 120 };

  const events = [
    { ts, type: "action", data: { kind: "change", selector: "input#qty", value: "3" } },
    { ts, type: "action", data: { kind: "key", selector: "input#q", key: "Enter" } },
    { ts, type: "navigation", data: { kind: "load", url: "http://localhost:3000/" } },
    { ts, type: "network", data: { method: "POST", url: "http://localhost:3000/api", resourceType: "Fetch", durationMs: 12, status: 500, statusText: "Server Error", mimeType: "application/json", requestBody: "{}", responseBody: "{}" } },
    { ts, type: "network", data: { method: "GET", url: "http://localhost:3000/api", resourceType: "XHR", durationMs: 0, error: "net::ERR_ABORTED", canceled: true } },
    { ts, type: "console", data: { level: "error", text: "broken", stack: [frame] } },
    { ts, type: "exception", data: { message: "TypeError: x", stack: [frame] } },
    { ts, type: "log", data: { level: "warn", source: "deprecation", text: "old API", url: "http://localhost:3000/" } },
    { ts, type: "dom", data: { added: ["Out of stock"], removed: [] } }
  ];
  extension.send({ type: "EVENTS", events });
  await waitFor(() => store.size === events.length, { what: "all events" });

  assert.equal(bridge.rejectedMessages, 0);
  assert.deepEqual(store.all().map(({ ts, type, data }) => ({ ts, type, data })), events);
});

test("follows the page URL from navigation events", async () => {
  const { bridge, port } = await setup();
  const extension = await connectExtension(port);

  // A navigation from before the HELLO is history, not the current page
  extension.send({ type: "HELLO", recording: true, page: PAGE });
  extension.send({ type: "EVENTS", events: [{ ts: Date.now() - 5000, type: "navigation", data: { kind: "load", url: "http://localhost:3000/earlier" } }] });
  await waitFor(() => bridge.store.size === 1, { what: "the queued event" });
  assert.deepEqual(bridge.page, PAGE);

  await sleep(5);
  extension.send({ type: "EVENTS", events: [{ ts: Date.now(), type: "navigation", data: { kind: "route", url: "http://localhost:3000/checkout" } }] });
  await waitFor(() => bridge.page?.url.endsWith("/checkout"), { what: "route change" });
  assert.equal(bridge.page.title, "Cart");

  extension.send({ type: "EVENTS", events: [{ ts: Date.now(), type: "navigation", data: { kind: "load", url: "http://localhost:3000/orders" } }] });
  await waitFor(() => bridge.page?.url.endsWith("/orders"), { what: "page load" });
  assert.equal(bridge.page.title, "");
});

test("clears the timeline on SESSION_STOP", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);

  extension.send({ type: "HELLO", recording: true, page: PAGE });
  extension.send({ type: "EVENTS", events: [logEvent("secret business")] });
  await waitFor(() => store.size === 1, { what: "event" });

  extension.send({ type: "SESSION_STOP" });
  await waitFor(() => !bridge.recording, { what: "stop" });

  assert.equal(store.size, 0);
  assert.equal(bridge.page, null);
});

test("starts with an empty timeline on SESSION_START", async () => {
  const { store, bridge, port } = await setup();
  const extension = await connectExtension(port);

  extension.send({ type: "EVENTS", events: [logEvent("previous tab")] });
  await waitFor(() => store.size === 1, { what: "event" });

  extension.send({ type: "SESSION_START", page: PAGE });
  extension.send({ type: "EVENTS", events: [logEvent("new tab")] });
  await waitFor(() => store.all()[0]?.data.text === "new tab", { what: "new session" });

  assert.equal(store.size, 1);
  assert.deepEqual(bridge.page, PAGE);
});

test("clears the timeline a while after the extension disconnects", async () => {
  const { store, bridge, port } = await setup({ disconnectClearMs: 150 });
  const extension = await connectExtension(port);

  extension.send({ type: "HELLO", recording: true, page: PAGE });
  extension.send({ type: "EVENTS", events: [logEvent("kept for a moment")] });
  await waitFor(() => store.size === 1, { what: "event" });

  await extension.close();
  await waitFor(() => !bridge.connected, { what: "disconnect" });
  assert.equal(store.size, 1); // not cleared right away

  await waitFor(() => store.size === 0, { what: "the timeline to clear" });
  assert.equal(bridge.recording, false);
  assert.equal(bridge.page, null);
});

test("keeps the timeline when the extension reconnects in time", async () => {
  const { store, bridge, port } = await setup({ disconnectClearMs: 150 });
  const first = await connectExtension(port);

  first.send({ type: "EVENTS", events: [logEvent("before restart")] });
  await waitFor(() => store.size === 1, { what: "event" });
  await first.close();
  await waitFor(() => !bridge.connected, { what: "disconnect" });

  // The service worker restarted and came back
  const second = await connectExtension(port);
  second.send({ type: "HELLO", recording: true, page: PAGE });
  await sleep(300);

  assert.equal(store.size, 1);
  assert.equal(bridge.recording, true);
});

test("the newest connection replaces the previous one", async () => {
  const { store, bridge, port } = await setup();
  const first = await connectExtension(port);
  const closed = new Promise((resolve) => first.socket.once("close", resolve));

  const second = await connectExtension(port);
  await closed;

  second.send({ type: "EVENTS", events: [logEvent("from the new connection")] });
  await waitFor(() => store.size === 1, { what: "event" });
  assert.equal(bridge.connected, true);
});

test("asks the extension for the current page", async () => {
  const page = { title: "Cart", url: "http://localhost:3000/cart", text: "Your cart is empty" };
  const { bridge, port } = await setup();
  const extension = await connectExtension(port, { page });
  await waitFor(() => bridge.connected, { what: "connection" });

  assert.deepEqual(await bridge.getPage(), page);
  assert.deepEqual(extension.requests, [{ type: "REQUEST", id: 1, method: "getPage" }]);
  assert.deepEqual(bridge.page, { title: "Cart", url: "http://localhost:3000/cart" });
});

test("reports page request failures", async () => {
  // Not connected
  const { bridge, port } = await setup({ requestTimeoutMs: 100 });
  await assert.rejects(bridge.getPage(), /not connected/);

  // The extension answers with an error
  const failing = await connectExtension(port, { page: new Error("Cannot access a chrome:// URL") });
  await waitFor(() => bridge.connected, { what: "connection" });
  await assert.rejects(bridge.getPage(), /Cannot access a chrome:\/\/ URL/);

  // The extension answers with something that is not a page
  await connectExtension(port, { page: { title: 1 } });
  await sleep(50);
  await assert.rejects(bridge.getPage(), /unreadable page/);

  // The extension never answers
  await connectExtension(port);
  await sleep(50);
  await assert.rejects(bridge.getPage(), /did not answer in time/);
  await failing.close();
});

test("fails a waiting request when the extension disconnects", async () => {
  const { bridge, port } = await setup();
  const extension = await connectExtension(port);
  await waitFor(() => bridge.connected, { what: "connection" });

  const request = assert.rejects(bridge.getPage(), /disconnected/);
  await extension.close();
  await request;
});

test("explains when the port is already in use instead of crashing", async () => {
  const { port } = await setup();
  const messages = [];
  const second = new Bridge({ store: new Store(), port, log: (message) => messages.push(message) });
  open.push(second);

  await second.start();

  assert.equal(second.listening, false);
  assert.match(second.listenError, new RegExp(`Port ${port} is in use`));
  assert.equal(messages.length, 1);
});
