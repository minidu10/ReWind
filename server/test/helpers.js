import http from "node:http";
import net from "node:net";
import { SourceMapGenerator } from "source-map-js";
import WebSocket from "ws";

// Shared by the tests; not a test file itself.

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until check() returns something truthy
export async function waitFor(check, { timeoutMs = 5000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A local web server. `files` maps a path to a string body, or to
// { status, headers, body }. Every requested path is recorded in `requests`.
export async function startFileServer(files) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const path = request.url.split("?")[0];
    requests.push(path);
    const file = files[path];
    if (file === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    const { status = 200, headers = {}, body = "" } = typeof file === "string" ? { body: file } : file;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })
  };
}

// A two-line "bundle" and the map back to its two original files:
//   bundle 1:23 (the `items.map` call) → src/Cart.jsx 3:10
//   bundle 2:1  (the `render()` call)  → src/main.jsx 2:1
export const CART_SOURCE = ["export function render(items) {", "  // show every item", "  return items.map((item) => item.name);", "}"].join("\n");
export const MAIN_SOURCE = ['import { render } from "./Cart.jsx";', "render(undefined);"].join("\n");
export const BUNDLE_CODE = ["function render(items){return items.map(function(i){return i.name})}", "render(undefined);"].join("\n");
export const BUNDLE_FRAME = { fn: "render", url: "", line: 1, col: 30 };

export function buildSourceMap({ sources = ["webpack://shop/./src/Cart.jsx", "webpack://shop/./src/main.jsx"], withContent = true } = {}) {
  const [cart, main] = sources;
  const generator = new SourceMapGenerator({ file: "app.js" });
  generator.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: cart });
  generator.addMapping({ generated: { line: 1, column: 22 }, original: { line: 3, column: 9 }, source: cart, name: "items" });
  generator.addMapping({ generated: { line: 2, column: 0 }, original: { line: 2, column: 0 }, source: main });
  if (withContent) {
    generator.setSourceContent(cart, CART_SOURCE);
    generator.setSourceContent(main, MAIN_SOURCE);
  }
  return generator.toString();
}

// A stand-in for the Chrome extension's WebSocket connection
export function connectExtension(port, { origin = EXTENSION_ORIGIN, page } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin === null ? {} : { origin });
    const requests = [];

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      if (message.type === "REQUEST" && page !== undefined) {
        const reply = page instanceof Error ? { error: page.message } : { result: page };
        socket.send(JSON.stringify({ type: "RESPONSE", id: message.id, ...reply }));
      }
    });
    socket.on("error", reject);
    socket.on("open", () =>
      resolve({
        socket,
        requests,
        send: (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
        close: () =>
          new Promise((done) => {
            if (socket.readyState === WebSocket.CLOSED) return done();
            socket.once("close", done);
            socket.close();
          })
      })
    );
  });
}

// Resolves with the HTTP status the server answered a refused connection with
export function connectionRefusal(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin === null ? {} : { origin });
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error(`Connection from origin ${origin} was accepted`));
    });
    socket.on("error", () => {});
  });
}
