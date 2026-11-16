import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUNDLE_CODE, EXTENSION_ID, buildSourceMap, connectExtension, connectionRefusal, freePort, startFileServer, waitFor } from "./helpers.js";

// Starts the real server.js the way an editor does (MCP over stdio), connects a
// fake extension over WebSocket, and uses the tools like an AI assistant would.

const SERVER_PATH = fileURLToPath(new URL("../server.js", import.meta.url));

let app; // the "web app under development": serves a bundle and its source map
let port;
let client;
let extension;
let stderr = "";

const PAGE_TEXT = { title: "Cart", url: "", text: "Your cart\nSomething went wrong" };

before(async () => {
  app = await startFileServer({
    "/assets/app.js": `${BUNDLE_CODE}\n//# sourceMappingURL=app.js.map`,
    "/assets/app.js.map": buildSourceMap()
  });
  PAGE_TEXT.url = `${app.url}/cart`;
  port = await freePort();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, REWIND_PORT: String(port), REWIND_EXTENSION_ID: EXTENSION_ID, REWIND_WINDOW_SECONDS: "120" },
    stderr: "pipe"
  });
  transport.stderr.on("data", (chunk) => (stderr += chunk));

  client = new Client({ name: "rewind-test", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await extension?.close();
  await client?.close();
  await app?.close();
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((part) => part.text).join("\n"), isError: Boolean(result.isError) };
}

// Sends a recording session: a click that triggers a failing request and an exception
async function record() {
  const now = Date.now();
  const frame = { fn: "render", url: `${app.url}/assets/app.js`, line: 1, col: 30 };

  extension.send({ type: "HELLO", recording: true, page: { url: `${app.url}/cart`, title: "Cart" } });
  extension.send({
    type: "EVENTS",
    events: [
      { ts: now - 20_000, type: "navigation", data: { kind: "load", url: `${app.url}/cart` } },
      { ts: now - 19_000, type: "console", data: { level: "log", text: "cart loaded" } },
      { ts: now - 9_000, type: "action", data: { kind: "click", selector: "button#buy", text: "Add to cart" } },
      {
        ts: now - 8_900,
        type: "network",
        data: {
          method: "POST",
          url: `${app.url}/api/cart`,
          resourceType: "Fetch",
          durationMs: 120,
          status: 500,
          statusText: "Internal Server Error",
          mimeType: "application/json",
          requestBody: '{"productId":7,"qty":1}',
          responseBody: '{"error":"inventory service unavailable"}'
        }
      },
      { ts: now - 8_700, type: "exception", data: { message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: [frame, { ...frame, fn: "(anonymous)", line: 2, col: 1 }] } },
      { ts: now - 8_600, type: "dom", data: { added: ["Something went wrong"], removed: ["Add to cart"] } }
    ]
  });
  await waitFor(async () => (await call("get_status")).text.includes("Timeline: 6 events"), { what: "the events to arrive" });
}

test("starts up and lists the seven tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["check_fix", "explain_error", "get_errors", "get_page", "get_request", "get_status", "get_timeline"]
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
  }
  assert.equal(client.getServerVersion().name, "rewind");
  assert.match(client.getInstructions(), /get_errors/);
});

test("explains what to do when nothing is recording", async () => {
  const status = await call("get_status");
  assert.match(status.text, /Recording: no/);
  assert.match(status.text, /Extension: not connected/);
  assert.match(status.text, /Start recording/);

  assert.match((await call("get_timeline")).text, /No events in the last 30s/);
  assert.match((await call("get_errors")).text, /No errors in the timeline/);
  assert.match((await call("explain_error")).text, /No errors in the timeline/);

  const page = await call("get_page");
  assert.equal(page.isError, true);
  assert.match(page.text, /not connected/);

  const fix = await call("check_fix", { wait_seconds: 0 });
  assert.equal(fix.isError, true);
});

test("refuses WebSocket connections that are not from the configured extension", async () => {
  assert.equal(await connectionRefusal(port, null), 401);
  assert.equal(await connectionRefusal(port, "http://localhost:3000"), 401);
  assert.equal(await connectionRefusal(port, "https://evil.example.com"), 401);
  assert.equal(await connectionRefusal(port, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"), 401);

  assert.match((await call("get_status")).text, /Extension: not connected/);
});

test("records events from the extension and reports status", async () => {
  extension = await connectExtension(port, { page: PAGE_TEXT });
  await record();

  const { text } = await call("get_status");
  assert.match(text, /Recording: yes/);
  assert.match(text, /Extension: connected/);
  assert.ok(text.includes(`Page: "Cart" ${app.url}/cart`));
  assert.match(text, /Timeline: 6 events in the last 120s \(action 1, navigation 1, network 1, console 1, exception 1, dom 1\)/);
  assert.match(text, /Errors: 2/);
  assert.match(text, /Last code update: 2\d\.\ds ago \(#1 page load\)/);
});

test("get_timeline shows one line per event, filtered by time, type, and limit", async () => {
  const recent = (await call("get_timeline")).text.split("\n");
  assert.match(recent[0], /^6 events in the last 30s:$/);
  assert.match(recent[1], /^#1 \[-2\d\.\ds\] page load 127\.0\.0\.1:\d+\/cart$/);
  assert.match(recent[3], /^#3 \[-\d\.\ds\] click button#buy "Add to cart"$/);
  assert.match(recent[4], /^#4 \[-\d\.\ds\] POST \/api\/cart → 500 \(120ms\)$/);
  assert.match(recent[5], /^#5 \[-\d\.\ds\] EXCEPTION TypeError: Cannot read properties of undefined \(reading 'map'\) \(\/assets\/app\.js:1:30\)$/);
  assert.match(recent[6], /^#6 \[-\d\.\ds\] page changed: \+"Something went wrong" -"Add to cart"$/);

  const short = (await call("get_timeline", { seconds: 15 })).text;
  assert.match(short, /^4 events in the last 15s:/);
  assert.equal(short.includes("page load"), false);

  const filtered = (await call("get_timeline", { types: ["network", "action"] })).text;
  assert.match(filtered, /^2 events/);
  assert.equal(filtered.includes("EXCEPTION"), false);

  const limited = (await call("get_timeline", { limit: 2 })).text.split("\n");
  assert.match(limited[0], /^2 events in the last 30s \(the most recent of 6; raise limit to see more\):$/);
  assert.match(limited[1], /^#5 /);

  assert.match((await call("get_timeline", { types: ["log"] })).text, /^No log events in the last 30s\.$/);
});

test("get_errors lists errors with the top frame mapped to the original source", async () => {
  const { text } = await call("get_errors");
  const lines = text.split("\n");

  assert.equal(lines[0], "2 errors:");
  assert.match(lines[1], /^#4 .* POST \/api\/cart → 500 \(120ms\)$/);
  assert.match(lines[2], /^#5 .* EXCEPTION TypeError/);
  assert.equal(lines[3], "    source: src/Cart.jsx:3:10 in render");
  assert.equal(lines[4], "    > return items.map((item) => item.name);");
});

test("explain_error shows the error, its mapped stack, and what led to it", async () => {
  const { text } = await call("explain_error");

  assert.match(text, /^Error: #5 /);
  assert.match(text, /Message:\nTypeError: Cannot read properties of undefined \(reading 'map'\)/);
  assert.ok(text.includes("  at render (src/Cart.jsx:3:10)  [bundle: /assets/app.js:1:30]\n      > return items.map((item) => item.name);"));
  assert.ok(text.includes("  at (anonymous) (src/main.jsx:2:1)"));

  const before = text.slice(text.indexOf("What happened in the 15s before it:"));
  assert.match(before, /#3 .* click button#buy "Add to cart"\n#4 .* POST \/api\/cart → 500/);
  assert.match(before, /#1 .* page load/); // 11s before the error
  assert.equal(before.includes("#6 "), false); // happened after the error
});

test("explain_error takes an id and a longer look back", async () => {
  const narrow = (await call("explain_error", { id: 5, before_seconds: 5 })).text;
  assert.match(narrow, /What happened in the 5s before it:\n#3 .* click button#buy/);
  assert.equal(narrow.includes("page load"), false);

  const request = (await call("explain_error", { id: 4 })).text;
  assert.match(request, /^Error: #4 /);
  assert.ok(request.includes('Request body:\n{"productId":7,"qty":1}'));
  assert.ok(request.includes('Response body:\n{"error":"inventory service unavailable"}'));
  assert.match(request, /#3 .* click button#buy/);

  const missing = await call("explain_error", { id: 999 });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No event #999/);
});

test("get_request returns the full request and response", async () => {
  const { text } = await call("get_request", { id: 4 });
  assert.ok(text.includes(`POST ${app.url}/api/cart`));
  assert.match(text, /Type: Fetch \(application\/json\)/);
  assert.match(text, /Duration: 120ms/);
  assert.match(text, /Status: 500 Internal Server Error/);
  assert.ok(text.includes('Request body:\n{"productId":7,"qty":1}'));
  assert.ok(text.includes('Response body:\n{"error":"inventory service unavailable"}'));

  const notRequest = await call("get_request", { id: 3 });
  assert.equal(notRequest.isError, true);
  assert.match(notRequest.text, /is a action event, not a network request/);

  assert.equal((await call("get_request", { id: 999 })).isError, true);
});

test("get_page asks the extension for the live page", async () => {
  const { text, isError } = await call("get_page");
  assert.equal(isError, false);
  assert.equal(text, `Title: Cart\nURL: ${app.url}/cart\n\nVisible text:\nYour cart\nSomething went wrong`);
  assert.deepEqual(extension.requests.map((request) => request.method), ["getPage"]);
});

test("rejects tool arguments that do not match the schema", async () => {
  for (const [name, args] of [
    ["get_timeline", { seconds: -5 }],
    ["get_timeline", { types: ["everything"] }],
    ["get_request", {}],
    ["get_request", { id: "four" }],
    ["check_fix", { wait_seconds: 9999 }]
  ]) {
    const outcome = await call(name, args).then(
      (result) => result.isError,
      () => true // older SDK versions reject the call instead
    );
    assert.equal(outcome, true, `${name} ${JSON.stringify(args)}`);
  }
});

test("check_fix reports errors that are still there after a hot update", async () => {
  const before = await call("check_fix", { wait_seconds: 0 });
  assert.match(before.text, /Last code update: .* \(#1 page load\)/);
  assert.match(before.text, /2 errors since the update:/);
  assert.match(before.text, /source: src\/Cart\.jsx:3:10 in render/);

  const now = Date.now();
  extension.send({
    type: "EVENTS",
    events: [
      { ts: now - 1000, type: "console", data: { level: "log", text: "[vite] hot updated: /src/Cart.jsx" } },
      { ts: now - 500, type: "action", data: { kind: "click", selector: "button#buy", text: "Add to cart" } },
      { ts: now - 400, type: "console", data: { level: "error", text: "Failed to add to cart" } }
    ]
  });
  await waitFor(async () => (await call("get_status")).text.includes("Timeline: 9 events"), { what: "the hot update" });

  const { text } = await call("check_fix", { wait_seconds: 0 });
  assert.match(text, /Last code update: .* \(#7 hot update: \[vite\] hot updated: \/src\/Cart\.jsx\)/);
  assert.match(text, /1 error since the update:\n#9 .* console\.error: Failed to add to cart/);
  assert.equal(text.includes("#5 "), false); // the old exception is not counted against the new code
});

test("check_fix confirms a fix and waits for the update to arrive", async () => {
  const started = Date.now();
  setTimeout(() => {
    const now = Date.now();
    extension.send({
      type: "EVENTS",
      events: [
        { ts: now, type: "console", data: { level: "log", text: "[vite] hot updated: /src/Cart.jsx" } },
        { ts: now + 1, type: "action", data: { kind: "click", selector: "button#buy", text: "Add to cart" } },
        { ts: now + 2, type: "network", data: { method: "POST", url: `${app.url}/api/cart`, resourceType: "Fetch", durationMs: 40, status: 200 } }
      ]
    });
  }, 300);

  const { text } = await call("check_fix", { wait_seconds: 1 });
  assert.ok(Date.now() - started >= 950, "check_fix should wait before checking");
  assert.match(text, /Last code update: .* \(#10 hot update/);
  assert.match(text, /No errors since the update\.$/);

  // Errors from before the fix are still in the timeline
  assert.match((await call("get_errors")).text, /^3 errors:/);
});

test("ignores bad messages from the extension", async () => {
  extension.send("this is not JSON");
  extension.send({ type: "EVENTS", events: "all of them" });
  extension.send({ type: "DROP_TABLE" });
  extension.send({
    type: "EVENTS",
    events: [
      { ts: Date.now(), type: "console", data: { level: "log", text: "valid" } },
      { ts: Date.now(), type: "console", data: { level: "log" } },
      { ts: Date.now(), type: "made-up", data: {} }
    ]
  });

  const status = await waitFor(
    async () => {
      const { text } = await call("get_status");
      return text.includes("Rejected messages: 4") ? text : null;
    },
    { what: "the bad messages to be counted" }
  );

  assert.match(status, /Timeline: 13 events/); // 12 from before + the one valid event
  assert.match(status, /Recording: yes/);
  assert.match((await call("get_timeline", { seconds: 5, types: ["console"] })).text, /console\.log: valid/);
});

test("does not write recorded data to its log", async () => {
  assert.equal(stderr.includes("inventory service unavailable"), false);
  assert.equal(stderr.includes("Add to cart"), false);
});

test("clears everything when the recording stops", async () => {
  extension.send({ type: "SESSION_STOP" });
  await waitFor(async () => (await call("get_status")).text.includes("Recording: no"), { what: "the stop" });

  const status = (await call("get_status")).text;
  assert.match(status, /Timeline: 0 events/);
  assert.match(status, /Errors: 0/);
  assert.match(status, /Page: \(unknown\)/);
  assert.match(status, /Last code update: none seen/);

  assert.match((await call("get_errors")).text, /No errors in the timeline/);
  assert.match((await call("get_timeline", { seconds: 120 })).text, /No events in the last 120s/);
  assert.equal((await call("get_request", { id: 4 })).isError, true);
  assert.equal((await call("explain_error", { id: 5 })).isError, true);
});

test("logs to stderr only and exits when the editor disconnects", async () => {
  assert.match(stderr, new RegExp(`\\[rewind\\] waiting for the Chrome extension on ws://127\\.0\\.0\\.1:${port}`));

  await extension.close();
  extension = null;
  const pid = client.transport.pid;
  await client.close();
  client = null;

  // The port is free again once the process is gone
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { what: "the server process to exit" }
  );
});
