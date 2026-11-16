import { SourceMapConsumer } from "source-map-js";

// Maps a stack frame in a served bundle back to the original source file and
// line. Scripts and source maps are only ever fetched from this machine.

const MAX_SCRIPT_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 3000;
const CACHE_MS = 5000; // short, because dev servers rebuild the same URL
const MAX_CACHED = 50;
const MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=([^\s'"`]+)\s*$/;

export function isLocalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

// "webpack://app/./src/App.jsx" → "src/App.jsx"; a relative "App.jsx" is
// resolved against the script URL → "src/App.jsx"
export function cleanSource(source, scriptUrl) {
  const raw = String(source);
  const bundled = raw.match(/^webpack(?:-internal)?:\/\/\/?[^/]*\/(.*)$/);

  let path = raw;
  if (bundled) {
    path = bundled[1];
  } else if (!/^(?:[a-z]:[\\/]|\/|file:)/i.test(raw)) {
    // Not an absolute path on disk: resolve it like the browser would
    try {
      path = decodeURIComponent(new URL(raw, scriptUrl).pathname).replace(/^\//, "");
    } catch {
      // Keep the name as it is in the map
    }
  }
  return path.replace(/[?#].*$/, "").replace(/^(?:\.\/)+/, "");
}

function findMappingUrl(script) {
  // The comment is on the last non-empty line; only look at the tail
  const tail = script.slice(-20000).trimEnd();
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  return lastLine.match(MAPPING_URL)?.[1] ?? null;
}

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const header = url.slice(0, comma);
  const body = url.slice(comma + 1);
  return /;base64/i.test(header) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
}

export function createSourceMapper({ fetch = globalThis.fetch, cacheMs = CACHE_MS, now = Date.now } = {}) {
  const cache = new Map(); // script URL → { at, consumer: Promise<SourceMapConsumer | null> }

  async function fetchLocalText(url) {
    if (!isLocalUrl(url)) return null;
    // A redirect could point anywhere, so it is treated as a failure
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    if (Number(response.headers.get("content-length")) > MAX_SCRIPT_BYTES) return null;
    const text = await response.text();
    return { text: text.length > MAX_SCRIPT_BYTES ? null : text, header: response.headers.get("sourcemap") };
  }

  async function loadConsumer(scriptUrl) {
    try {
      const script = await fetchLocalText(scriptUrl);
      if (!script?.text) return null;

      const mappingUrl = findMappingUrl(script.text) ?? script.header;
      if (!mappingUrl) return null;

      let rawMap;
      if (mappingUrl.startsWith("data:")) {
        rawMap = decodeDataUrl(mappingUrl);
      } else {
        rawMap = (await fetchLocalText(new URL(mappingUrl, scriptUrl).href))?.text;
      }
      if (!rawMap) return null;

      return new SourceMapConsumer(JSON.parse(rawMap));
    } catch {
      return null; // unreachable server, bad JSON, bad map: fall back to the bundle frame
    }
  }

  function consumerFor(scriptUrl) {
    const cached = cache.get(scriptUrl);
    if (cached && now() - cached.at < cacheMs) return cached.consumer;

    const entry = { at: now(), consumer: loadConsumer(scriptUrl) };
    cache.delete(scriptUrl);
    cache.set(scriptUrl, entry);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return entry.consumer;
  }

  // Returns the frame, plus `source: { file, line, col, code? }` when it can be mapped.
  async function mapFrame(frame) {
    if (!frame?.url || !isLocalUrl(frame.url)) return frame;

    const consumer = await consumerFor(frame.url);
    if (!consumer) return frame;

    const position = consumer.originalPositionFor({ line: frame.line, column: Math.max(0, frame.col - 1) });
    if (!position.source || position.line == null) return frame;

    const source = {
      file: cleanSource(position.source, frame.url),
      line: position.line,
      col: (position.column ?? 0) + 1
    };

    const content = consumer.sourceContentFor(position.source, true);
    const code = content?.split("\n")[position.line - 1]?.trim();
    if (code) source.code = code.slice(0, 200);

    return { ...frame, source };
  }

  function mapStack(frames) {
    return Promise.all((frames ?? []).map(mapFrame));
  }

  return { mapFrame, mapStack };
}

// The frame most likely to be the developer's own code: the first one mapped
// outside node_modules, else the first one.
export function topFrame(frames) {
  if (!frames?.length) return null;
  return frames.find((frame) => frame.source && !frame.source.file.includes("node_modules")) ?? frames[0];
}
