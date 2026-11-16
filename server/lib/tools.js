import { z } from "zod";
import { isError } from "./store.js";
import { topFrame } from "./sourcemap.js";
import { formatDuration, formatEvent, formatEvents, formatFrame, formatLocation, relativeTime } from "./format.js";

// The MCP tools. Every tool returns plain text written for an AI assistant.

const EVENT_TYPES = ["action", "navigation", "network", "console", "exception", "log", "dom"];
const MAX_ERRORS = 50;
const MAX_CONTEXT_EVENTS = 150;
const HOW_TO_START = "Open the page in Chrome, click the Rewind extension icon, and press \"Start recording\".";

export function registerTools(server, { store, bridge, mapper, now = Date.now, sleep = defaultSleep }) {
  const text = (value) => ({ content: [{ type: "text", text: value }] });
  const failure = (value) => ({ content: [{ type: "text", text: value }], isError: true });
  const formatOptions = () => ({ now: now(), pageUrl: bridge.page?.url });

  // Why the timeline may be empty, or "" when recording is running
  function problem() {
    if (bridge.listenError) return bridge.listenError;
    if (!bridge.connected) return `The Rewind extension is not connected. ${HOW_TO_START}`;
    if (!bridge.recording) return `The Rewind extension is connected but not recording. ${HOW_TO_START}`;
    return "";
  }

  function withProblem(body) {
    const note = problem();
    return note ? `${body}\n\nNote: ${note}` : body;
  }

  function describeCodeUpdate(update) {
    if (!update) return "none seen in the timeline";
    const what = update.type === "navigation" ? "page load" : `hot update: ${update.data.text.slice(0, 80)}`;
    return `${relativeTime(update.ts, now()).slice(1)} ago (#${update.id} ${what})`;
  }

  async function mappedStack(event) {
    return mapper.mapStack(event.data?.stack ?? []);
  }

  // One error line, plus where it came from in the original source
  async function errorSummary(event) {
    let line = formatEvent(event, formatOptions());
    const frame = topFrame(await mappedStack(event));
    if (frame?.source) {
      line += `\n    source: ${formatLocation(frame)} in ${frame.fn}`;
      if (frame.source.code) line += `\n    > ${frame.source.code}`;
    }
    return line;
  }

  function networkDetails(data) {
    const lines = [
      `${data.method} ${data.url}`,
      `Type: ${data.resourceType}${data.mimeType ? ` (${data.mimeType})` : ""}`,
      `Duration: ${formatDuration(data.durationMs ?? 0)}`
    ];
    if (data.status !== undefined) lines.push(`Status: ${data.status} ${data.statusText ?? ""}`.trimEnd());
    if (data.error) lines.push(`Failed: ${data.error}${data.canceled ? " (canceled)" : ""}`);
    lines.push("", "Request body:", data.requestBody || "(none recorded)");
    lines.push("", "Response body:", data.responseBody || "(none recorded; bodies are kept for fetch/XHR text responses only)");
    return lines.join("\n");
  }

  // ---------- get_status ----------

  server.registerTool(
    "get_status",
    {
      title: "Rewind status",
      description:
        "Check whether Rewind is recording a browser tab: recording state, the page being recorded, and how many events of each type are in the timeline. Call this first if other Rewind tools return nothing.",
      inputSchema: {}
    },
    async () => {
      const counts = store.counts();
      const total = store.size;
      const page = bridge.page;
      const lines = [
        `Recording: ${bridge.recording ? "yes" : "no"}`,
        `Extension: ${bridge.connected ? "connected" : "not connected"}`,
        `Page: ${page?.url ? `${page.title ? `"${page.title}" ` : ""}${page.url}` : "(unknown)"}`,
        `Timeline: ${total} events in the last ${Math.round(store.windowMs / 1000)}s` +
          (total ? ` (${EVENT_TYPES.filter((type) => counts[type]).map((type) => `${type} ${counts[type]}`).join(", ")})` : ""),
        `Errors: ${store.errors().length}`,
        `Last code update: ${describeCodeUpdate(store.lastCodeUpdate())}`
      ];
      if (bridge.rejectedMessages) lines.push(`Rejected messages: ${bridge.rejectedMessages}`);
      return text(withProblem(lines.join("\n")));
    }
  );

  // ---------- get_timeline ----------

  server.registerTool(
    "get_timeline",
    {
      title: "Browser timeline",
      description:
        "What happened in the recorded browser tab, oldest first, one line per event: user actions (clicks, input changes, form submits), page loads and route changes, network requests, console output, exceptions, and visible page changes. Times are relative to now. Use the #id with get_request or explain_error for details.",
      inputSchema: {
        seconds: z.number().positive().max(3600).default(30).describe("How far back to look, in seconds"),
        types: z.array(z.enum(EVENT_TYPES)).optional().describe("Only these event types (default: all)"),
        limit: z.number().int().positive().max(1000).default(200).describe("Maximum number of events (the most recent are kept)")
      }
    },
    async ({ seconds, types, limit }) => {
      let events = store.range(now() - seconds * 1000);
      if (types?.length) events = events.filter((event) => types.includes(event.type));

      if (!events.length) {
        return text(withProblem(`No ${types?.length ? types.join("/") + " " : ""}events in the last ${seconds}s.`));
      }

      const shown = events.slice(-limit);
      let header = `${shown.length} events in the last ${seconds}s`;
      if (shown.length < events.length) header += ` (the most recent of ${events.length}; raise limit to see more)`;
      return text(withProblem(`${header}:\n${formatEvents(shown, formatOptions())}`));
    }
  );

  // ---------- get_errors ----------

  server.registerTool(
    "get_errors",
    {
      title: "Browser errors",
      description:
        "All errors in the recorded timeline: uncaught exceptions, console.error calls, browser errors, and failed network requests (HTTP 4xx/5xx or network failures). Stack frames are mapped through source maps to the original file and line. Use explain_error with an #id to see what led to one.",
      inputSchema: {}
    },
    async () => {
      const errors = store.errors();
      if (!errors.length) return text(withProblem("No errors in the timeline."));

      const shown = errors.slice(-MAX_ERRORS);
      const lines = await Promise.all(shown.map(errorSummary));
      let header = `${errors.length} error${errors.length === 1 ? "" : "s"}`;
      if (shown.length < errors.length) header += ` (showing the most recent ${shown.length})`;
      return text(withProblem(`${header}:\n${lines.join("\n")}`));
    }
  );

  // ---------- explain_error ----------

  server.registerTool(
    "explain_error",
    {
      title: "Explain an error",
      description:
        "Everything about one error: the full message, its stack mapped to original source files, the request and response if it is a failed request, and the timeline of what happened just before it (user actions, requests, console output, page changes). Without an id it explains the most recent error.",
      inputSchema: {
        id: z.number().int().positive().optional().describe("Event #id from get_errors or get_timeline (default: the most recent error)"),
        before_seconds: z.number().positive().max(600).default(15).describe("How many seconds of history before the error to include")
      }
    },
    async ({ id, before_seconds }) => {
      let event;
      if (id !== undefined) {
        event = store.get(id);
        if (!event) return failure(`No event #${id} in the timeline. It may have aged out; call get_errors for current ids.`);
      } else {
        event = store.errors().at(-1);
        if (!event) return text(withProblem("No errors in the timeline."));
      }

      const options = formatOptions();
      const sections = [`${isError(event) ? "Error" : "Event"}: ${formatEvent(event, options)}`];

      if (event.type === "network") {
        sections.push(networkDetails(event.data));
      } else {
        const message = event.data.message ?? event.data.text;
        if (message) sections.push(`Message:\n${message}`);
      }

      const stack = await mappedStack(event);
      if (stack.length) {
        sections.push(`Stack:\n${stack.map((frame) => `  ${formatFrame(frame, options.pageUrl)}`).join("\n")}`);
      }

      const before = store.range(event.ts - before_seconds * 1000, event.ts).filter((other) => other.id !== event.id);
      const shown = before.slice(-MAX_CONTEXT_EVENTS);
      sections.push(
        shown.length
          ? `What happened in the ${before_seconds}s before it${shown.length < before.length ? ` (last ${shown.length} events)` : ""}:\n${formatEvents(shown, options)}`
          : `Nothing else was recorded in the ${before_seconds}s before it.`
      );

      const update = store.lastCodeUpdate();
      if (update && update.ts > event.ts) {
        sections.push(`Note: the code was updated after this error (${describeCodeUpdate(update)}). Use check_fix to see whether it still happens.`);
      }

      return text(sections.join("\n\n"));
    }
  );

  // ---------- get_request ----------

  server.registerTool(
    "get_request",
    {
      title: "Request details",
      description:
        "The full recorded details of one network request: method, URL, status, timing, and the request and response bodies (secrets are masked, long bodies are cut).",
      inputSchema: {
        id: z.number().int().positive().describe("Event #id of a network event from get_timeline or get_errors")
      }
    },
    async ({ id }) => {
      const event = store.get(id);
      if (!event) return failure(`No event #${id} in the timeline. It may have aged out; call get_timeline for current ids.`);
      if (event.type !== "network") {
        return failure(`Event #${id} is a ${event.type} event, not a network request: ${formatEvent(event, formatOptions())}`);
      }
      return text(`#${event.id} [${relativeTime(event.ts, now())}]\n${networkDetails(event.data)}`);
    }
  );

  // ---------- get_page ----------

  server.registerTool(
    "get_page",
    {
      title: "Current page",
      description:
        "What the recorded tab shows right now: page title, URL, and the visible text of the page. Useful to check what the user actually sees (error messages, empty lists, wrong values).",
      inputSchema: {}
    },
    async () => {
      const note = problem();
      if (note) return failure(note);
      try {
        const page = await bridge.getPage();
        return text(`Title: ${page.title}\nURL: ${page.url}\n\nVisible text:\n${page.text || "(the page has no visible text)"}`);
      } catch (err) {
        return failure(`Could not read the page: ${err.message}`);
      }
    }
  );

  // ---------- check_fix ----------

  server.registerTool(
    "check_fix",
    {
      title: "Check a fix",
      description:
        "After changing code, confirm the fix worked: waits a moment for the dev server to hot-update or the page to reload, then reports only the errors that happened since the last page load or hot update. If the bug needs a user action to trigger (a click, a form submit), ask the user to repeat it first.",
      inputSchema: {
        wait_seconds: z.number().min(0).max(30).default(3).describe("Seconds to wait for the reload or hot update before checking")
      }
    },
    async ({ wait_seconds }) => {
      if (wait_seconds > 0) await sleep(wait_seconds * 1000);

      const note = problem();
      if (note) return failure(note);

      const update = store.lastCodeUpdate();
      if (!update) {
        const errors = store.errors();
        const lines = await Promise.all(errors.slice(-MAX_ERRORS).map(errorSummary));
        return text(
          "No page load or hot update is in the timeline, so Rewind cannot tell whether the new code is running. " +
            "Reload the page (or ask the user to) and call check_fix again.\n\n" +
            (errors.length ? `Errors currently in the timeline (${errors.length}):\n${lines.join("\n")}` : "There are no errors in the timeline.")
        );
      }

      const since = store.range(update.ts);
      const errors = since.filter(isError);
      const header = `Last code update: ${describeCodeUpdate(update)}. ${since.length - 1} events since then.`;

      if (!errors.length) {
        const actions = since.filter((event) => event.type === "action").length;
        return text(
          `${header}\n\nNo errors since the update.` +
            (actions ? "" : " No user actions were recorded since then either; if the bug needs a click or a form submit, ask the user to repeat it and check again.")
        );
      }

      const lines = await Promise.all(errors.slice(-MAX_ERRORS).map(errorSummary));
      return text(`${header}\n\n${errors.length} error${errors.length === 1 ? "" : "s"} since the update:\n${lines.join("\n")}`);
    }
  );
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
