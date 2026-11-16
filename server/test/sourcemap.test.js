import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cleanSource, createSourceMapper, isLocalUrl, topFrame } from "../lib/sourcemap.js";
import { BUNDLE_CODE, BUNDLE_FRAME, buildSourceMap, startFileServer } from "./helpers.js";

let server;

before(async () => {
  const inlineMap = Buffer.from(buildSourceMap()).toString("base64");
  server = await startFileServer({
    "/assets/app.js": `${BUNDLE_CODE}\n//# sourceMappingURL=app.js.map\n`,
    "/assets/app.js.map": buildSourceMap(),
    "/assets/inline.js": `${BUNDLE_CODE}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${inlineMap}`,
    "/assets/header.js": { headers: { SourceMap: "/assets/app.js.map" }, body: BUNDLE_CODE },
    "/assets/nomap.js": BUNDLE_CODE,
    "/assets/nocontent.js": `${BUNDLE_CODE}\n//# sourceMappingURL=nocontent.js.map`,
    "/assets/nocontent.js.map": buildSourceMap({ withContent: false }),
    "/src/vite.jsx": `${BUNDLE_CODE}\n//# sourceMappingURL=vite.jsx.map`,
    "/src/vite.jsx.map": buildSourceMap({ sources: ["Cart.jsx", "main.jsx"] }),
    "/assets/badmap.js": `${BUNDLE_CODE}\n//# sourceMappingURL=badmap.js.map`,
    "/assets/badmap.js.map": "this is not JSON",
    "/assets/missingmap.js": `${BUNDLE_CODE}\n//# sourceMappingURL=gone.js.map`,
    "/assets/remotemap.js": `${BUNDLE_CODE}\n//# sourceMappingURL=https://maps.example.com/app.js.map`,
    "/assets/redirect.js": { status: 302, headers: { location: "https://cdn.example.com/app.js" } },
    "/assets/mention.js": `var note = "//# sourceMappingURL=fake.js.map";\n${BUNDLE_CODE}`
  });
});

after(() => server.close());

const frameIn = (path, extra = {}) => ({ ...BUNDLE_FRAME, url: `${server.url}${path}`, ...extra });

// A fetch that records every URL it is asked for
function spyFetch() {
  const urls = [];
  const fetch = (url, options) => {
    urls.push(String(url));
    return globalThis.fetch(url, options);
  };
  return { fetch, urls };
}

test("maps a bundle frame to the original file, line, and code", async () => {
  const mapper = createSourceMapper();
  const frame = await mapper.mapFrame(frameIn("/assets/app.js"));

  assert.deepEqual(frame, {
    fn: "render",
    url: `${server.url}/assets/app.js`,
    line: 1,
    col: 30,
    source: { file: "src/Cart.jsx", line: 3, col: 10, code: "return items.map((item) => item.name);" }
  });
});

test("maps every frame of a stack", async () => {
  const mapper = createSourceMapper();
  const stack = await mapper.mapStack([frameIn("/assets/app.js"), frameIn("/assets/app.js", { fn: "(anonymous)", line: 2, col: 1 })]);

  assert.deepEqual(stack.map((frame) => `${frame.source.file}:${frame.source.line}`), ["src/Cart.jsx:3", "src/main.jsx:2"]);
  assert.deepEqual(await mapper.mapStack(undefined), []);
});

test("reads inline base64 source maps", async () => {
  const frame = await createSourceMapper().mapFrame(frameIn("/assets/inline.js"));
  assert.equal(frame.source.file, "src/Cart.jsx");
  assert.equal(frame.source.line, 3);
});

test("uses the SourceMap response header when there is no comment", async () => {
  const frame = await createSourceMapper().mapFrame(frameIn("/assets/header.js"));
  assert.equal(frame.source.file, "src/Cart.jsx");
});

test("resolves relative source names against the script URL (Vite)", async () => {
  const frame = await createSourceMapper().mapFrame(frameIn("/src/vite.jsx"));
  assert.equal(frame.source.file, "src/Cart.jsx");
});

test("maps without a code line when the map has no sourcesContent", async () => {
  const frame = await createSourceMapper().mapFrame(frameIn("/assets/nocontent.js"));
  assert.deepEqual(frame.source, { file: "src/Cart.jsx", line: 3, col: 10 });
});

test("returns the frame unchanged when it cannot be mapped", async () => {
  const mapper = createSourceMapper();
  const unmappable = [
    frameIn("/assets/nomap.js"), // no source map
    frameIn("/assets/badmap.js"), // map is not JSON
    frameIn("/assets/missingmap.js"), // map is a 404
    frameIn("/assets/does-not-exist.js"), // script is a 404
    frameIn("/assets/mention.js"), // the comment is not on the last line
    frameIn("/assets/app.js", { line: 999, col: 1 }), // position outside the bundle
    { fn: "x", url: "http://127.0.0.1:1/app.js", line: 1, col: 1 }, // nothing listening
    { fn: "x", url: "", line: 1, col: 1 },
    { fn: "x", url: "<anonymous>", line: 1, col: 1 }
  ];

  for (const frame of unmappable) {
    assert.deepEqual(await mapper.mapFrame(frame), frame, frame.url);
  }
});

test("never fetches scripts from other machines", async () => {
  const { fetch, urls } = spyFetch();
  const mapper = createSourceMapper({ fetch });

  const remote = [
    "https://cdn.example.com/app.js",
    "http://192.168.1.10:3000/app.js",
    "http://localhost.example.com/app.js",
    "http://127.0.0.1.example.com/app.js",
    "file:///C:/Users/me/app.js",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js"
  ];
  for (const url of remote) {
    const frame = { fn: "x", url, line: 1, col: 1 };
    assert.deepEqual(await mapper.mapFrame(frame), frame);
  }

  assert.deepEqual(urls, []);
});

test("never fetches a source map from another machine", async () => {
  const { fetch, urls } = spyFetch();
  const frame = frameIn("/assets/remotemap.js");

  assert.deepEqual(await createSourceMapper({ fetch }).mapFrame(frame), frame);
  assert.deepEqual(urls, [`${server.url}/assets/remotemap.js`]);
});

test("does not follow redirects", async () => {
  const frame = frameIn("/assets/redirect.js");
  assert.deepEqual(await createSourceMapper().mapFrame(frame), frame);
});

test("fetches each script once, then again after the cache expires", async () => {
  const clock = { now: 1000 };
  const { fetch, urls } = spyFetch();
  const mapper = createSourceMapper({ fetch, cacheMs: 5000, now: () => clock.now });
  const frame = frameIn("/assets/app.js");

  await Promise.all([mapper.mapFrame(frame), mapper.mapFrame(frame)]);
  await mapper.mapFrame(frame);
  assert.equal(urls.length, 2); // the script and its map, once each

  clock.now = 7000; // the dev server may have rebuilt the bundle
  const again = await mapper.mapFrame(frame);
  assert.equal(urls.length, 4);
  assert.equal(again.source.file, "src/Cart.jsx");
});

test("knows which URLs are on this machine", () => {
  for (const url of ["http://localhost:5173/src/main.jsx", "https://localhost/app.js", "http://127.0.0.1:3000/a.js", "http://[::1]:3000/a.js", "http://app.localhost:3000/a.js"]) {
    assert.equal(isLocalUrl(url), true, url);
  }
  for (const url of ["https://example.com/a.js", "http://10.0.0.5/a.js", "http://localhost.evil.com/a.js", "http://evil.com/localhost/a.js", "http://127.0.0.1@evil.com/a.js", "ftp://localhost/a.js", "file:///a.js", "not a url", ""]) {
    assert.equal(isLocalUrl(url), false, url);
  }
});

test("cleans up source names from different bundlers", () => {
  const script = "http://localhost:5173/src/pages/Cart.jsx";
  assert.equal(cleanSource("webpack://shop/./src/Cart.jsx", script), "src/Cart.jsx");
  assert.equal(cleanSource("webpack:///./src/Cart.jsx?a1b2", script), "src/Cart.jsx");
  assert.equal(cleanSource("webpack-internal:///./src/Cart.jsx", script), "src/Cart.jsx");
  assert.equal(cleanSource("webpack://shop/node_modules/react-dom/index.js", script), "node_modules/react-dom/index.js");
  assert.equal(cleanSource("Cart.jsx", script), "src/pages/Cart.jsx");
  assert.equal(cleanSource("../../src/Cart.jsx", "http://localhost:3000/assets/js/app.js"), "src/Cart.jsx");
  assert.equal(cleanSource("/home/sam/shop/src/Cart.jsx", script), "/home/sam/shop/src/Cart.jsx");
  assert.equal(cleanSource("C:\\Users\\sam\\shop\\src\\Cart.jsx", script), "C:\\Users\\sam\\shop\\src\\Cart.jsx");
});

test("picks the first frame mapped outside node_modules as the top frame", () => {
  const library = { fn: "invoke", url: "u", line: 1, col: 1, source: { file: "node_modules/react-dom/index.js", line: 9, col: 1 } };
  const own = { fn: "render", url: "u", line: 1, col: 2, source: { file: "src/Cart.jsx", line: 3, col: 10 } };
  const unmapped = { fn: "x", url: "u", line: 1, col: 3 };

  assert.equal(topFrame([library, unmapped, own]), own);
  assert.equal(topFrame([unmapped, library]), unmapped);
  assert.equal(topFrame([]), null);
  assert.equal(topFrame(undefined), null);
});
