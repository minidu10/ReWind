import { hideSecrets } from "./secrets.js";

// Turns raw Chrome DevTools Protocol events into small, masked timeline events.
// It has no Chrome dependencies, so it can be tested in Node.

const ALWAYS_RECORDED = new Set(["Document", "XHR", "Fetch", "WebSocket", "EventSource"]);
const BODY_TYPES = new Set(["XHR", "Fetch"]);
// console.debug is kept (as "log") because Vite reports hot updates with it
const CONSOLE_LEVELS = { log: "log", debug: "log", info: "info", warning: "warn", error: "error", assert: "error" };
const SKIPPED_SCHEMES = /^(data|blob|chrome-extension|chrome|about|devtools):/i;
const MAX_PENDING_REQUESTS = 500;

export const LIMITS = { url: 500, text: 2000, body: 4000, label: 160, frames: 8, domItems: 10 };

function clip(value, max) {
  return hideSecrets(String(value ?? "")).slice(0, max);
}

function formatValue(type, value) {
  return type === "string" ? JSON.stringify(value) : String(value);
}

// A console argument as text: "hello", 42, {a: 1, b: "x"}, [1, 2], Error: ...
export function formatRemoteObject(arg) {
  if (!arg) return "";
  if ("value" in arg) {
    if (typeof arg.value === "string") return arg.value;
    try {
      return JSON.stringify(arg.value) ?? String(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.unserializableValue) return arg.unserializableValue;

  const properties = arg.preview?.properties;
  if (properties?.length && arg.subtype !== "error") {
    const more = arg.preview.overflow ? ", …" : "";
    if (arg.subtype === "array") {
      return `[${properties.map((p) => formatValue(p.type, p.value)).join(", ")}${more}]`;
    }
    return `{${properties.map((p) => `${p.name}: ${formatValue(p.type, p.value)}`).join(", ")}${more}}`;
  }

  return arg.description ?? `[${arg.type}]`;
}

export function toFrames(stackTrace) {
  return (stackTrace?.callFrames ?? []).slice(0, LIMITS.frames).map((frame) => ({
    fn: frame.functionName || "(anonymous)",
    url: clip(frame.url, LIMITS.url),
    line: frame.lineNumber + 1,
    col: frame.columnNumber + 1
  }));
}

export class Recorder {
  // emit(event)              called with { ts, type, data } for every timeline event
  // getResponseBody(id)      async, returns { body, base64Encoded } (Network.getResponseBody)
  // bindingName              name of the page → extension binding used by the page script
  constructor({ emit, getResponseBody, bindingName, now = Date.now }) {
    this.emitEvent = emit;
    this.getResponseBody = getResponseBody;
    this.bindingName = bindingName;
    this.now = now;
    this.requests = new Map();
  }

  reset() {
    this.requests.clear();
  }

  emit(type, data, ts = this.now()) {
    this.emitEvent({ ts, type, data });
  }

  // Returns a promise only so tests can await response-body lookups.
  handle(method, params) {
    switch (method) {
      case "Network.requestWillBeSent":
        return this.onRequest(params);
      case "Network.responseReceived":
        return this.onResponse(params);
      case "Network.loadingFinished":
        return this.onFinished(params);
      case "Network.loadingFailed":
        return this.onFailed(params);
      case "Runtime.consoleAPICalled":
        return this.onConsole(params);
      case "Runtime.exceptionThrown":
        return this.onException(params);
      case "Log.entryAdded":
        return this.onLog(params);
      case "Runtime.bindingCalled":
        return this.onBinding(params);
      case "Page.frameNavigated":
        return this.onNavigated(params);
      default:
        return undefined;
    }
  }

  // ---------- Network ----------

  onRequest({ requestId, request, type, redirectResponse }) {
    if (!request || SKIPPED_SCHEMES.test(request.url)) return;

    // A redirect reuses the request id: close the previous hop first
    const previous = this.requests.get(requestId);
    if (previous && redirectResponse) {
      previous.status = redirectResponse.status;
      previous.statusText = redirectResponse.statusText;
      this.finishRequest(requestId, previous);
    }

    if (this.requests.size >= MAX_PENDING_REQUESTS) {
      this.requests.delete(this.requests.keys().next().value);
    }

    this.requests.set(requestId, {
      startedAt: this.now(),
      method: request.method,
      url: clip(request.url, LIMITS.url),
      resourceType: type || previous?.resourceType || "Other",
      requestBody: request.postData ? clip(request.postData, LIMITS.body) : undefined
    });
  }

  onResponse({ requestId, response, type }) {
    const pending = this.requests.get(requestId);
    if (!pending || !response) return;
    pending.status = response.status;
    pending.statusText = response.statusText;
    pending.mimeType = response.mimeType;
    if (type) pending.resourceType = type;
  }

  async onFinished({ requestId }) {
    const pending = this.requests.get(requestId);
    if (!pending) return;

    const failed = pending.status >= 400;
    let responseBody;
    if (BODY_TYPES.has(pending.resourceType) || (failed && pending.resourceType === "Document")) {
      try {
        const result = await this.getResponseBody(requestId);
        if (result?.body && !result.base64Encoded) responseBody = clip(result.body, LIMITS.body);
      } catch {
        // The body is gone (navigation, cache eviction); the event is still useful
      }
    }

    this.finishRequest(requestId, pending, { responseBody });
  }

  onFailed({ requestId, errorText, canceled, blockedReason, corsErrorStatus }) {
    const pending = this.requests.get(requestId);
    if (!pending) return;

    const reason = corsErrorStatus?.corsError
      ? `CORS error: ${corsErrorStatus.corsError}`
      : blockedReason
        ? `blocked: ${blockedReason}`
        : errorText || "failed";

    this.finishRequest(requestId, pending, { error: clip(reason, LIMITS.label), canceled: Boolean(canceled) });
  }

  finishRequest(requestId, pending, extra = {}) {
    this.requests.delete(requestId);

    const failed = pending.status >= 400 || Boolean(extra.error);
    // Scripts, images, fonts, and styles are noise unless they fail
    if (!ALWAYS_RECORDED.has(pending.resourceType) && !failed) return;

    const data = {
      method: pending.method,
      url: pending.url,
      resourceType: pending.resourceType,
      durationMs: Math.max(0, this.now() - pending.startedAt)
    };
    if (pending.status !== undefined) data.status = pending.status;
    if (pending.statusText) data.statusText = clip(pending.statusText, LIMITS.label);
    if (pending.mimeType) data.mimeType = pending.mimeType;
    if (pending.requestBody) data.requestBody = pending.requestBody;
    if (extra.responseBody) data.responseBody = extra.responseBody;
    if (extra.error) data.error = extra.error;
    if (extra.canceled) data.canceled = true;

    // Timestamped at the moment the request was sent
    this.emit("network", data, pending.startedAt);
  }

  // ---------- Console, exceptions, browser log ----------

  onConsole({ type, args, stackTrace }) {
    const level = CONSOLE_LEVELS[type];
    if (!level) return;

    const data = {
      level,
      text: clip((args ?? []).map(formatRemoteObject).join(" "), LIMITS.text)
    };
    if (level === "error" || level === "warn") {
      const stack = toFrames(stackTrace);
      if (stack.length) data.stack = stack;
    }
    this.emit("console", data);
  }

  onException({ exceptionDetails }) {
    if (!exceptionDetails) return;

    const description = exceptionDetails.exception?.description;
    const message = description
      ? description.split("\n")[0]
      : [exceptionDetails.text, formatRemoteObject(exceptionDetails.exception)].filter(Boolean).join(" ");

    let stack = toFrames(exceptionDetails.stackTrace);
    if (!stack.length && exceptionDetails.url) {
      // Syntax errors have no stack, only a location
      stack = [
        {
          fn: "(anonymous)",
          url: clip(exceptionDetails.url, LIMITS.url),
          line: (exceptionDetails.lineNumber ?? 0) + 1,
          col: (exceptionDetails.columnNumber ?? 0) + 1
        }
      ];
    }

    this.emit("exception", { message: clip(message, LIMITS.text), stack });
  }

  onLog({ entry }) {
    if (!entry || (entry.level !== "error" && entry.level !== "warning")) return;
    // Failed requests are already recorded as network events
    if (entry.source === "network") return;

    const data = {
      level: entry.level === "warning" ? "warn" : "error",
      source: entry.source,
      text: clip(entry.text, LIMITS.text)
    };
    if (entry.url) data.url = clip(entry.url, LIMITS.url);
    this.emit("log", data);
  }

  // ---------- Events from the page script ----------

  onBinding({ name, payload }) {
    if (name !== this.bindingName) return;

    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const label = (value) => clip(value, LIMITS.label);

    switch (message.kind) {
      case "click":
      case "submit":
      case "change":
      case "key": {
        const data = { kind: message.kind, selector: label(message.selector) };
        if (message.text) data.text = label(message.text);
        if (message.value !== undefined) data.value = label(message.value);
        if (message.key) data.key = label(message.key);
        this.emit("action", data);
        break;
      }
      case "route":
        this.emit("navigation", { kind: "route", url: clip(message.url, LIMITS.url) });
        break;
      case "dom": {
        const list = (items) =>
          (Array.isArray(items) ? items : []).slice(0, LIMITS.domItems).map(label).filter(Boolean);
        const added = list(message.added);
        const removed = list(message.removed);
        if (added.length || removed.length) this.emit("dom", { added, removed });
        break;
      }
      default:
        break;
    }
  }

  onNavigated({ frame }) {
    if (!frame || frame.parentId) return; // top frame only
    if (SKIPPED_SCHEMES.test(frame.url)) return;
    this.emit("navigation", { kind: "load", url: clip(frame.url, LIMITS.url) });
  }
}
