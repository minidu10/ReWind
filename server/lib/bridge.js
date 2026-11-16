import { WebSocketServer } from "ws";
import { z } from "zod";

// The WebSocket endpoint the Chrome extension connects to. It listens on
// 127.0.0.1 only, accepts only chrome-extension:// origins, and validates
// every message before anything reaches the timeline.

export const DEFAULT_PORT = 54322;
const DISCONNECT_CLEAR_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;
const RETRY_LISTEN_MS = 3000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

// ---------- Message schemas ----------

const text = (max) => z.string().max(max);
const page = z.object({ url: text(4000), title: text(4000) });
const frame = z.object({
  fn: text(1000),
  url: text(4000),
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative()
});
const ts = z.number().finite().positive();

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ts,
    type: z.literal("action"),
    data: z.object({
      kind: z.enum(["click", "submit", "change", "key"]),
      selector: text(1000),
      text: text(1000).optional(),
      value: text(1000).optional(),
      key: text(100).optional()
    })
  }),
  z.object({
    ts,
    type: z.literal("navigation"),
    data: z.object({ kind: z.enum(["load", "route"]), url: text(4000) })
  }),
  z.object({
    ts,
    type: z.literal("network"),
    data: z.object({
      method: text(40),
      url: text(4000),
      resourceType: text(40),
      durationMs: z.number().finite().nonnegative(),
      status: z.number().int().optional(),
      statusText: text(1000).optional(),
      mimeType: text(200).optional(),
      requestBody: text(100000).optional(),
      responseBody: text(100000).optional(),
      error: text(1000).optional(),
      canceled: z.boolean().optional()
    })
  }),
  z.object({
    ts,
    type: z.literal("console"),
    data: z.object({
      level: z.enum(["log", "info", "warn", "error"]),
      text: text(20000),
      stack: z.array(frame).max(50).optional()
    })
  }),
  z.object({
    ts,
    type: z.literal("exception"),
    data: z.object({ message: text(20000), stack: z.array(frame).max(50) })
  }),
  z.object({
    ts,
    type: z.literal("log"),
    data: z.object({
      level: z.enum(["warn", "error"]),
      source: text(100),
      text: text(20000),
      url: text(4000).optional()
    })
  }),
  z.object({
    ts,
    type: z.literal("dom"),
    data: z.object({ added: z.array(text(1000)).max(50), removed: z.array(text(1000)).max(50) })
  })
]);

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("HELLO"), recording: z.boolean(), page: page.optional() }),
  z.object({ type: z.literal("SESSION_START"), page: page.optional() }),
  z.object({ type: z.literal("SESSION_STOP") }),
  // Events are checked one by one, so one bad event does not lose the batch
  z.object({ type: z.literal("EVENTS"), events: z.array(z.unknown()).max(1000) }),
  z.object({
    type: z.literal("RESPONSE"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: text(2000).optional()
  })
]);

const pageResult = z.object({ title: text(4000), url: text(4000), text: text(200000) });

// ---------- Bridge ----------

export class Bridge {
  constructor({
    store,
    port = DEFAULT_PORT,
    extensionId,
    disconnectClearMs = DISCONNECT_CLEAR_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    log = () => {}
  }) {
    this.store = store;
    this.port = port;
    this.extensionId = extensionId || null;
    this.disconnectClearMs = disconnectClearMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;

    this.server = null;
    this.socket = null;
    this.listening = false;
    this.listenError = null;
    this.recording = false;
    this.page = null;
    this.pageAt = 0; // when the extension last reported the page
    this.rejectedMessages = 0;
    this.pending = new Map(); // request id → { resolve, reject, timer }
    this.nextRequestId = 1;
    this.clearTimer = null;
    this.retryTimer = null;
    this.closed = false;
  }

  get connected() {
    return this.socket !== null;
  }

  isAllowedOrigin(origin) {
    const match = EXTENSION_ORIGIN.exec(origin ?? "");
    if (!match) return false;
    return this.extensionId === null || match[1] === this.extensionId;
  }

  // Resolves once the port is open. If another Rewind server already has the
  // port (two editors open), it resolves anyway and keeps retrying, so the MCP
  // tools can explain the situation instead of the server crashing.
  start() {
    return new Promise((resolve) => {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }) => this.isAllowedOrigin(origin)
      });
      this.server = server;

      server.on("listening", () => {
        this.listening = true;
        this.listenError = null;
        this.port = server.address().port;
        resolve();
      });

      server.on("error", (err) => {
        if (this.listening) {
          this.log(`WebSocket server error: ${err.message}`);
          return;
        }
        this.listenError =
          err.code === "EADDRINUSE"
            ? `Port ${this.port} is in use, probably by a Rewind server started from another editor. Close it to use Rewind here.`
            : `Could not listen on port ${this.port}: ${err.message}`;
        this.log(this.listenError);
        server.close();
        if (!this.closed) {
          this.retryTimer = setTimeout(() => this.start(), RETRY_LISTEN_MS);
          this.retryTimer.unref();
        }
        resolve();
      });

      server.on("connection", (socket) => this.onConnection(socket));
    });
  }

  onConnection(socket) {
    // Only one extension is recording at a time; the newest connection wins
    if (this.socket) this.socket.close(1000, "replaced");
    this.socket = socket;
    clearTimeout(this.clearTimer);

    socket.on("message", (raw, isBinary) => {
      if (socket !== this.socket) return;
      if (isBinary || !this.onMessage(raw.toString("utf8"))) this.rejectedMessages++;
    });

    socket.on("error", () => {}); // "close" follows

    socket.on("close", () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.failPending("The Rewind extension disconnected.");

      // The service worker may just be restarting; give it time to come back
      this.clearTimer = setTimeout(() => this.reset(), this.disconnectClearMs);
      this.clearTimer.unref();
    });
  }

  // Returns false when the message was rejected.
  onMessage(raw) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return false;
    }

    const parsed = messageSchema.safeParse(json);
    if (!parsed.success) return false;
    const message = parsed.data;

    switch (message.type) {
      case "HELLO":
        this.recording = message.recording;
        if (message.page) this.setPage(message.page);
        return true;

      case "SESSION_START":
        this.store.clear();
        this.recording = true;
        this.setPage(message.page ?? null);
        return true;

      case "SESSION_STOP":
        this.reset();
        return true;

      case "EVENTS": {
        const valid = [];
        for (const candidate of message.events) {
          const event = eventSchema.safeParse(candidate);
          if (event.success) valid.push(event.data);
        }
        this.store.add(valid);
        if (valid.length) this.recording = true;
        // Keep the page URL current without asking the extension. Queued
        // events can be older than the page the extension last reported.
        const navigation = valid.findLast((event) => event.type === "navigation" && event.ts >= this.pageAt);
        if (navigation) {
          // A full load has a new title that is not known yet; a route change usually keeps it
          const title = navigation.data.kind === "route" ? (this.page?.title ?? "") : "";
          this.page = { url: navigation.data.url, title };
        }
        return valid.length === message.events.length;
      }

      case "RESPONSE": {
        const waiting = this.pending.get(message.id);
        if (!waiting) return false;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error !== undefined) waiting.reject(new Error(message.error));
        else waiting.resolve(message.result);
        return true;
      }

      default:
        return false;
    }
  }

  // Forget the recording: nothing from a stopped session stays in memory
  reset() {
    this.store.clear();
    this.recording = false;
    this.setPage(null);
  }

  setPage(page) {
    this.page = page;
    this.pageAt = Date.now();
  }

  failPending(reason) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  request(method) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("The Rewind extension is not connected."));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Rewind extension did not answer in time."));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "REQUEST", id, method }));
    });
  }

  // Current page title, URL, and visible text, read live from the tab
  async getPage() {
    const result = pageResult.safeParse(await this.request("getPage"));
    if (!result.success) throw new Error("The Rewind extension sent an unreadable page.");
    this.setPage({ url: result.data.url, title: result.data.title });
    return result.data;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.clearTimer);
    clearTimeout(this.retryTimer);
    this.failPending("The Rewind server is shutting down.");
    if (!this.server) return;
    for (const client of this.server.clients) client.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
