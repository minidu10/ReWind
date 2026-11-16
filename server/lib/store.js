// A rolling timeline of what happened in the recorded tab.
// Events are { id, ts, type, data }, kept sorted by ts (oldest first).

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_EVENTS = 5000;

// Console lines that dev servers print when new code reaches the page.
// Vite: "[vite] hot updated: /src/App.jsx", "[vite] page reload"
// webpack: "[HMR] Updated modules:", "[webpack-dev-server] App hot update..."
// Next.js / React: "[Fast Refresh] rebuilding", "[Fast Refresh] done in 120ms"
const HOT_UPDATE =
  /\[vite\] (?:hot updated|css hot updated|hmr update|page reload)|\[HMR\] (?:Updated modules|App is up to date|Checking for updates)|\[webpack-dev-server\] App (?:hot update|updated)|\[Fast Refresh\]/i;

export function isError(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "exception":
      return true;
    case "console":
    case "log":
      return data.level === "error";
    case "network":
      return data.status >= 400 || (Boolean(data.error) && !data.canceled);
    default:
      return false;
  }
}

export function isCodeUpdate(event) {
  if (event.type === "navigation") return event.data?.kind === "load";
  if (event.type === "console") return HOT_UPDATE.test(event.data?.text ?? "");
  return false;
}

export class Store {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxEvents = DEFAULT_MAX_EVENTS, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.maxEvents = maxEvents;
    this.now = now;
    this.events = [];
    this.nextId = 1;
  }

  // Adds events ({ ts, type, data }) and returns them with their new ids.
  add(events) {
    const now = this.now();
    const added = [];

    for (const { ts, type, data } of events) {
      // A clock that runs ahead must not push events into the future
      const event = { id: this.nextId++, ts: Math.min(ts, now), type, data };

      // Network events are stamped with their start time, so they arrive late:
      // insert after the last event that is not newer.
      let index = this.events.length;
      while (index > 0 && this.events[index - 1].ts > event.ts) index--;
      this.events.splice(index, 0, event);
      added.push(event);
    }

    this.prune();
    return added;
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++;
    drop = Math.max(drop, this.events.length - this.maxEvents);
    if (drop > 0) this.events.splice(0, drop);
  }

  clear() {
    this.events = [];
  }

  get size() {
    this.prune();
    return this.events.length;
  }

  all() {
    this.prune();
    return this.events.slice();
  }

  get(id) {
    this.prune();
    return this.events.find((event) => event.id === id) ?? null;
  }

  // Events with from <= ts <= to
  range(from = -Infinity, to = Infinity) {
    return this.all().filter((event) => event.ts >= from && event.ts <= to);
  }

  errors(from = -Infinity) {
    return this.range(from).filter(isError);
  }

  // The most recent page load or hot update, or null
  lastCodeUpdate() {
    return this.all().findLast(isCodeUpdate) ?? null;
  }

  counts() {
    const counts = {};
    for (const event of this.all()) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }
}
