// Turns timeline events into compact text for the AI assistant:
//   #57 [-9.6s] POST /api/cart → 500 (120ms)

const MAX_LINE = 300;

function oneLine(text, max = MAX_LINE) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function quote(text, max = 80) {
  return JSON.stringify(oneLine(text, max));
}

// Path only for the page's own origin, host + path for everything else
export function shortUrl(url, pageUrl) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(pageUrl) && new URL(pageUrl).origin === parsed.origin;
    } catch {
      // No usable page URL: show the host
    }
    return oneLine(sameOrigin ? path : parsed.host + path, 160);
  } catch {
    return oneLine(url, 160);
  }
}

// "-9.6s" = 9.6 seconds before `now`
export function relativeTime(ts, now) {
  const seconds = (ts - now) / 1000;
  const sign = seconds > 0 ? "+" : "-";
  return `${sign}${Math.abs(seconds).toFixed(1)}s`;
}

export function formatDuration(ms) {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// "src/Cart.jsx:42:7" when mapped, else "app.js:1:2345"
export function formatLocation(frame, pageUrl) {
  if (!frame) return "";
  if (frame.source) return `${frame.source.file}:${frame.source.line}:${frame.source.col}`;
  return `${shortUrl(frame.url, pageUrl) || "(unknown)"}:${frame.line}:${frame.col}`;
}

export function formatFrame(frame, pageUrl) {
  let line = `at ${frame.fn || "(anonymous)"} (${formatLocation(frame, pageUrl)})`;
  if (frame.source) line += `  [bundle: ${shortUrl(frame.url, pageUrl)}:${frame.line}:${frame.col}]`;
  if (frame.source?.code) line += `\n      > ${frame.source.code}`;
  return line;
}

function describe(event, pageUrl) {
  const data = event.data ?? {};

  switch (event.type) {
    case "action": {
      if (data.kind === "key") return `key ${data.key} in ${data.selector}`;
      let text = `${data.kind} ${data.selector}`;
      if (data.text) text += ` ${quote(data.text)}`;
      if (data.value !== undefined) text += ` = ${quote(data.value)}`;
      return text;
    }

    case "navigation":
      return data.kind === "load" ? `page load ${shortUrl(data.url)}` : `route change → ${shortUrl(data.url, pageUrl)}`;

    case "network": {
      const request = `${data.method} ${shortUrl(data.url, pageUrl)}`;
      const duration = `(${formatDuration(data.durationMs ?? 0)})`;
      if (data.error) return `${request} ✗ ${data.canceled ? "canceled" : oneLine(data.error, 120)} ${duration}`;
      return `${request} → ${data.status ?? "?"} ${duration}`;
    }

    case "console": {
      const where = data.stack?.length ? ` (${formatLocation(data.stack[0], pageUrl)})` : "";
      return `console.${data.level}: ${oneLine(data.text)}${where}`;
    }

    case "exception": {
      const where = data.stack?.length ? ` (${formatLocation(data.stack[0], pageUrl)})` : "";
      return `EXCEPTION ${oneLine(data.message)}${where}`;
    }

    case "log":
      return `browser ${data.level} [${data.source}]: ${oneLine(data.text)}`;

    case "dom": {
      const parts = [
        ...(data.added ?? []).map((text) => `+${quote(text, 60)}`),
        ...(data.removed ?? []).map((text) => `-${quote(text, 60)}`)
      ];
      return `page changed: ${oneLine(parts.join(" "))}`;
    }

    default:
      return `${event.type} ${oneLine(JSON.stringify(data))}`;
  }
}

export function formatEvent(event, { now = Date.now(), pageUrl } = {}) {
  return `#${event.id} [${relativeTime(event.ts, now)}] ${describe(event, pageUrl)}`;
}

export function formatEvents(events, options) {
  return events.map((event) => formatEvent(event, options)).join("\n");
}
