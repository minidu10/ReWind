import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, Recorder, formatRemoteObject, toFrames } from "../lib/recorder.js";

const BINDING = "__rewindEvent";
const fake = (...parts) => parts.join("");

// A recorder with a clock the test controls and fake response bodies
function setup({ bodies = {} } = {}) {
  const events = [];
  const clock = { now: 1000 };
  const recorder = new Recorder({
    bindingName: BINDING,
    emit: (event) => events.push(event),
    now: () => clock.now,
    getResponseBody: async (requestId) => {
      if (!(requestId in bodies)) throw new Error("No resource with given identifier found");
      return bodies[requestId];
    }
  });
  return { recorder, events, clock };
}

function request(requestId, url, { method = "GET", type = "Fetch", postData } = {}) {
  return { requestId, type, request: { url, method, postData } };
}

function response(requestId, status, { statusText = "", mimeType = "application/json", type } = {}) {
  return { requestId, type, response: { status, statusText, mimeType } };
}

function binding(message) {
  return { name: BINDING, payload: JSON.stringify(message) };
}

// ---------- Network ----------

test("records a fetch with its status, duration, and bodies", async () => {
  const { recorder, events, clock } = setup({ bodies: { r1: { body: '{"error":"out of stock"}', base64Encoded: false } } });

  recorder.handle("Network.requestWillBeSent", request("r1", "http://localhost:3000/api/cart", { method: "POST", postData: '{"id":7}' }));
  clock.now = 1120;
  recorder.handle("Network.responseReceived", response("r1", 500, { statusText: "Internal Server Error" }));
  await recorder.handle("Network.loadingFinished", { requestId: "r1" });

  assert.deepEqual(events, [
    {
      ts: 1000, // when the request was sent, not when it finished
      type: "network",
      data: {
        method: "POST",
        url: "http://localhost:3000/api/cart",
        resourceType: "Fetch",
        durationMs: 120,
        status: 500,
        statusText: "Internal Server Error",
        mimeType: "application/json",
        requestBody: '{"id":7}',
        responseBody: '{"error":"out of stock"}'
      }
    }
  ]);
});

test("skips successful scripts, images, and styles but records failed ones", async () => {
  const { recorder, events } = setup();

  recorder.handle("Network.requestWillBeSent", request("ok", "http://localhost:3000/app.js", { type: "Script" }));
  recorder.handle("Network.responseReceived", response("ok", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "ok" });
  assert.equal(events.length, 0);

  recorder.handle("Network.requestWillBeSent", request("bad", "http://localhost:3000/logo.png", { type: "Image" }));
  recorder.handle("Network.responseReceived", response("bad", 404));
  await recorder.handle("Network.loadingFinished", { requestId: "bad" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.status, 404);
  assert.equal(events[0].data.resourceType, "Image");
});

test("does not ask for the body of documents that loaded fine", async () => {
  const asked = [];
  const events = [];
  const recorder = new Recorder({
    bindingName: BINDING,
    emit: (event) => events.push(event),
    getResponseBody: async (id) => {
      asked.push(id);
      return { body: "<html></html>", base64Encoded: false };
    }
  });

  recorder.handle("Network.requestWillBeSent", request("doc", "http://localhost:3000/", { type: "Document" }));
  recorder.handle("Network.responseReceived", response("doc", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "doc" });

  recorder.handle("Network.requestWillBeSent", request("doc2", "http://localhost:3000/missing", { type: "Document" }));
  recorder.handle("Network.responseReceived", response("doc2", 404));
  await recorder.handle("Network.loadingFinished", { requestId: "doc2" });

  assert.deepEqual(asked, ["doc2"]);
  assert.equal(events[0].data.responseBody, undefined);
  assert.equal(events[1].data.responseBody, "<html></html>");
});

test("still records the request when the body is gone or binary", async () => {
  const { recorder, events } = setup({ bodies: { bin: { body: "AAECAw==", base64Encoded: true } } });

  recorder.handle("Network.requestWillBeSent", request("gone", "http://localhost:3000/api/a"));
  recorder.handle("Network.responseReceived", response("gone", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "gone" });

  recorder.handle("Network.requestWillBeSent", request("bin", "http://localhost:3000/api/b"));
  recorder.handle("Network.responseReceived", response("bin", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "bin" });

  assert.equal(events.length, 2);
  assert.equal("responseBody" in events[0].data, false);
  assert.equal("responseBody" in events[1].data, false);
});

test("records failed, blocked, CORS, and canceled requests", () => {
  const { recorder, events } = setup();

  recorder.handle("Network.requestWillBeSent", request("a", "http://localhost:9999/api"));
  recorder.handle("Network.loadingFailed", { requestId: "a", errorText: "net::ERR_CONNECTION_REFUSED" });

  recorder.handle("Network.requestWillBeSent", request("b", "http://localhost:3000/ad.js", { type: "Script" }));
  recorder.handle("Network.loadingFailed", { requestId: "b", errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "inspector" });

  recorder.handle("Network.requestWillBeSent", request("c", "https://api.example.com/v1"));
  recorder.handle("Network.loadingFailed", {
    requestId: "c",
    errorText: "net::ERR_FAILED",
    corsErrorStatus: { corsError: "MissingAllowOriginHeader" }
  });

  recorder.handle("Network.requestWillBeSent", request("d", "http://localhost:3000/api/search?q=a"));
  recorder.handle("Network.loadingFailed", { requestId: "d", errorText: "net::ERR_ABORTED", canceled: true });

  assert.deepEqual(
    events.map((event) => [event.data.error, event.data.canceled]),
    [
      ["net::ERR_CONNECTION_REFUSED", undefined],
      ["blocked: inspector", undefined],
      ["CORS error: MissingAllowOriginHeader", undefined],
      ["net::ERR_ABORTED", true]
    ]
  );
});

test("records each hop of a redirect", async () => {
  const { recorder, events, clock } = setup({ bodies: { r: { body: "{}", base64Encoded: false } } });

  recorder.handle("Network.requestWillBeSent", request("r", "http://localhost:3000/old", { type: "Fetch" }));
  clock.now = 1050;
  recorder.handle("Network.requestWillBeSent", {
    ...request("r", "http://localhost:3000/new", { type: "Fetch" }),
    redirectResponse: { status: 302, statusText: "Found" }
  });
  clock.now = 1080;
  recorder.handle("Network.responseReceived", response("r", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "r" });

  assert.deepEqual(
    events.map((event) => [event.ts, event.data.url, event.data.status, event.data.durationMs]),
    [
      [1000, "http://localhost:3000/old", 302, 50],
      [1050, "http://localhost:3000/new", 200, 30]
    ]
  );
});

test("ignores data:, blob:, and extension URLs, and events for unknown requests", async () => {
  const { recorder, events } = setup();

  recorder.handle("Network.requestWillBeSent", request("a", "data:text/plain,hello"));
  recorder.handle("Network.requestWillBeSent", request("b", "blob:http://localhost:3000/1234"));
  recorder.handle("Network.requestWillBeSent", request("c", "chrome-extension://abc/script.js"));
  for (const id of ["a", "b", "c", "never-seen"]) {
    recorder.handle("Network.responseReceived", response(id, 500));
    await recorder.handle("Network.loadingFinished", { requestId: id });
    recorder.handle("Network.loadingFailed", { requestId: id, errorText: "x" });
  }

  assert.equal(events.length, 0);
});

test("masks secrets in URLs and bodies, and cuts long bodies", async () => {
  const token = fake("sk_", "live_", "abcdefghijklmnopqrstuvwx");
  const { recorder, events } = setup({
    bodies: { r: { body: `{"token":"abc","data":"${"x".repeat(LIMITS.body)}"}`, base64Encoded: false } }
  });

  recorder.handle(
    "Network.requestWillBeSent",
    request("r", "http://localhost:3000/api/pay?api_key=12345", { method: "POST", postData: `{"password":"hunter2","key":"${token}"}` })
  );
  recorder.handle("Network.responseReceived", response("r", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "r" });

  const { url, requestBody, responseBody } = events[0].data;
  assert.equal(url, "http://localhost:3000/api/pay?api_key=[HIDDEN]");
  assert.equal(requestBody, '{"password":"[HIDDEN]","key":"[HIDDEN_API_KEY]"}');
  assert.ok(responseBody.startsWith('{"token":"[HIDDEN]"'));
  assert.equal(responseBody.length, LIMITS.body);
});

test("forgets pending requests on reset", async () => {
  const { recorder, events } = setup();
  recorder.handle("Network.requestWillBeSent", request("r", "http://localhost:3000/api"));
  recorder.reset();
  recorder.handle("Network.responseReceived", response("r", 200));
  await recorder.handle("Network.loadingFinished", { requestId: "r" });
  assert.equal(events.length, 0);
});

// ---------- Console ----------

test("records console calls with their level", () => {
  const { recorder, events } = setup();
  const call = (type, ...values) =>
    recorder.handle("Runtime.consoleAPICalled", { type, args: values.map((value) => ({ type: typeof value, value })) });

  call("log", "hello", 42);
  call("info", "info");
  call("warning", "careful");
  call("error", "broken");
  call("assert", "assertion failed");
  call("debug", "[vite] hot updated: /src/App.jsx");
  call("table", "ignored");
  call("startGroup", "ignored");

  assert.deepEqual(
    events.map((event) => [event.type, event.data.level, event.data.text]),
    [
      ["console", "log", "hello 42"],
      ["console", "info", "info"],
      ["console", "warn", "careful"],
      ["console", "error", "broken"],
      ["console", "error", "assertion failed"],
      ["console", "log", "[vite] hot updated: /src/App.jsx"]
    ]
  );
});

test("keeps the stack for console errors and warnings only", () => {
  const { recorder, events } = setup();
  const stackTrace = { callFrames: [{ functionName: "save", url: "http://localhost:3000/app.js", lineNumber: 9, columnNumber: 4 }] };

  recorder.handle("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "x" }], stackTrace });
  recorder.handle("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x" }], stackTrace });

  assert.deepEqual(events[0].data.stack, [{ fn: "save", url: "http://localhost:3000/app.js", line: 10, col: 5 }]);
  assert.equal("stack" in events[1].data, false);
});

test("formats console arguments like DevTools does", () => {
  assert.equal(formatRemoteObject({ type: "string", value: "text" }), "text");
  assert.equal(formatRemoteObject({ type: "number", value: 3 }), "3");
  assert.equal(formatRemoteObject({ type: "object", subtype: "null", value: null }), "null");
  assert.equal(formatRemoteObject({ type: "object", value: { a: 1 } }), '{"a":1}');
  assert.equal(formatRemoteObject({ type: "undefined" }), "[undefined]");
  assert.equal(formatRemoteObject({ type: "number", unserializableValue: "NaN" }), "NaN");
  assert.equal(formatRemoteObject(undefined), "");

  const object = {
    type: "object",
    description: "Object",
    preview: {
      overflow: true,
      properties: [
        { name: "id", type: "number", value: "7" },
        { name: "name", type: "string", value: "Sam" }
      ]
    }
  };
  assert.equal(formatRemoteObject(object), '{id: 7, name: "Sam", …}');

  const array = {
    type: "object",
    subtype: "array",
    description: "Array(2)",
    preview: { overflow: false, properties: [{ name: "0", type: "number", value: "1" }, { name: "1", type: "string", value: "b" }] }
  };
  assert.equal(formatRemoteObject(array), '[1, "b"]');

  const error = {
    type: "object",
    subtype: "error",
    description: "TypeError: x is not a function\n    at save (app.js:10:5)",
    preview: { properties: [{ name: "stack", type: "string", value: "…" }] }
  };
  assert.equal(formatRemoteObject(error), "TypeError: x is not a function\n    at save (app.js:10:5)");
});

test("limits stacks to the first frames and names anonymous functions", () => {
  const callFrames = Array.from({ length: 20 }, (_, i) => ({ functionName: "", url: "http://localhost/a.js", lineNumber: i, columnNumber: 0 }));
  const frames = toFrames({ callFrames });
  assert.equal(frames.length, LIMITS.frames);
  assert.deepEqual(frames[0], { fn: "(anonymous)", url: "http://localhost/a.js", line: 1, col: 1 });
  assert.deepEqual(toFrames(undefined), []);
});

// ---------- Exceptions and browser log ----------

test("records an uncaught exception with a 1-based stack", () => {
  const { recorder, events } = setup();
  recorder.handle("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught",
      exception: {
        type: "object",
        subtype: "error",
        description: "TypeError: Cannot read properties of undefined (reading 'map')\n    at render (http://localhost:3000/app.js:1:120)"
      },
      stackTrace: {
        callFrames: [
          { functionName: "render", url: "http://localhost:3000/app.js", lineNumber: 0, columnNumber: 119 },
          { functionName: "", url: "http://localhost:3000/app.js", lineNumber: 0, columnNumber: 300 }
        ]
      }
    }
  });

  assert.deepEqual(events, [
    {
      ts: 1000,
      type: "exception",
      data: {
        message: "TypeError: Cannot read properties of undefined (reading 'map')",
        stack: [
          { fn: "render", url: "http://localhost:3000/app.js", line: 1, col: 120 },
          { fn: "(anonymous)", url: "http://localhost:3000/app.js", line: 1, col: 301 }
        ]
      }
    }
  ]);
});

test("records thrown non-errors and syntax errors without a stack", () => {
  const { recorder, events } = setup();

  recorder.handle("Runtime.exceptionThrown", {
    exceptionDetails: { text: "Uncaught", exception: { type: "string", value: "boom" } }
  });
  recorder.handle("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught SyntaxError: Unexpected token '}'",
      url: "http://localhost:3000/app.js",
      lineNumber: 41,
      columnNumber: 2
    }
  });
  recorder.handle("Runtime.exceptionThrown", {});

  assert.equal(events.length, 2);
  assert.deepEqual(events[0].data, { message: "Uncaught boom", stack: [] });
  assert.deepEqual(events[1].data, {
    message: "Uncaught SyntaxError: Unexpected token '}'",
    stack: [{ fn: "(anonymous)", url: "http://localhost:3000/app.js", line: 42, col: 3 }]
  });
});

test("records browser warnings and errors, but not network or info entries", () => {
  const { recorder, events } = setup();
  const entry = (level, source, text, url) => recorder.handle("Log.entryAdded", { entry: { level, source, text, url } });

  entry("error", "security", "Mixed Content: blocked", "http://localhost:3000/");
  entry("warning", "deprecation", "This API is deprecated");
  entry("error", "network", "Failed to load resource: 500");
  entry("info", "other", "just info");
  entry("verbose", "other", "noise");

  assert.deepEqual(
    events.map((event) => [event.type, event.data]),
    [
      ["log", { level: "error", source: "security", text: "Mixed Content: blocked", url: "http://localhost:3000/" }],
      ["log", { level: "warn", source: "deprecation", text: "This API is deprecated" }]
    ]
  );
});

// ---------- Page script events ----------

test("turns page script messages into action, navigation, and dom events", () => {
  const { recorder, events } = setup();

  recorder.handle("Runtime.bindingCalled", binding({ kind: "click", selector: "button#buy", text: "Add to cart" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "change", selector: 'input[name="qty"]', value: "" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "key", selector: "input#search", key: "Enter" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "submit", selector: "form#checkout" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "route", url: "http://localhost:3000/cart?token=abc" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "dom", added: ["Out of stock"], removed: ["Loading…"] }));

  assert.deepEqual(
    events.map((event) => [event.type, event.data]),
    [
      ["action", { kind: "click", selector: "button#buy", text: "Add to cart" }],
      ["action", { kind: "change", selector: 'input[name="qty"]', value: "" }],
      ["action", { kind: "key", selector: "input#search", key: "Enter" }],
      ["action", { kind: "submit", selector: "form#checkout" }],
      ["navigation", { kind: "route", url: "http://localhost:3000/cart?token=[HIDDEN]" }],
      ["dom", { added: ["Out of stock"], removed: ["Loading…"] }]
    ]
  );
});

test("ignores other bindings, bad payloads, unknown kinds, and empty dom changes", () => {
  const { recorder, events } = setup();

  recorder.handle("Runtime.bindingCalled", { name: "someOtherBinding", payload: JSON.stringify({ kind: "click", selector: "a" }) });
  recorder.handle("Runtime.bindingCalled", { name: BINDING, payload: "not json" });
  recorder.handle("Runtime.bindingCalled", { name: BINDING, payload: "null" });
  recorder.handle("Runtime.bindingCalled", binding({ kind: "scroll", selector: "body" }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "dom", added: [], removed: "nope" }));

  assert.equal(events.length, 0);
});

test("limits and masks what a page can send through the binding", () => {
  const { recorder, events } = setup();
  const key = fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789");

  recorder.handle("Runtime.bindingCalled", binding({ kind: "click", selector: "a".repeat(1000), text: `copy ${key}` }));
  recorder.handle("Runtime.bindingCalled", binding({ kind: "dom", added: Array.from({ length: 50 }, (_, i) => `row ${i}`), removed: [] }));

  assert.equal(events[0].data.selector.length, LIMITS.label);
  assert.equal(events[0].data.text, "copy [HIDDEN_API_KEY]");
  assert.equal(events[1].data.added.length, LIMITS.domItems);
});

// ---------- Navigation ----------

test("records top-frame page loads only", () => {
  const { recorder, events } = setup();

  recorder.handle("Page.frameNavigated", { frame: { id: "main", url: "http://localhost:3000/cart" } });
  recorder.handle("Page.frameNavigated", { frame: { id: "child", parentId: "main", url: "https://ads.example.com/frame" } });
  recorder.handle("Page.frameNavigated", { frame: { id: "main", url: "about:blank" } });

  assert.deepEqual(events, [{ ts: 1000, type: "navigation", data: { kind: "load", url: "http://localhost:3000/cart" } }]);
});

test("ignores CDP events it does not know", () => {
  const { recorder, events } = setup();
  assert.equal(recorder.handle("Network.dataReceived", { requestId: "x" }), undefined);
  assert.equal(events.length, 0);
});
