import { Recorder } from "./lib/recorder.js";
import { BINDING_NAME, PAGE_SCRIPT } from "./lib/page-script.js";
import { hideSecrets } from "./lib/secrets.js";

const SERVER_URL = "ws://127.0.0.1:54322";
const PROTOCOL_VERSION = "1.3";
const RECONNECT_MS = 3000;
const FLUSH_MS = 250;
const BATCH_SIZE = 200;
const MAX_QUEUE = 3000; // events kept while the server is not running
const MAX_PAGE_TEXT = 20000;

let tabId = null;
let socket = null;
let greeted = false; // HELLO has been sent on the current socket
let queue = [];
let eventCount = 0;
let flushTimer = null;
let reconnectTimer = null;

const recorder = new Recorder({
  bindingName: BINDING_NAME,
  emit: (event) => {
    if (tabId === null) return;
    eventCount++;
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  },
  getResponseBody: (requestId) => command("Network.getResponseBody", { requestId })
});

// Chrome can restart this worker; the recorded tab is restored from session storage.
const ready = chrome.storage.session.get("tabId").then(async ({ tabId: stored }) => {
  if (stored == null) return;
  tabId = stored;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch {
    // Still attached from before the restart
  }
  try {
    await enableRecording();
    startTimers();
  } catch {
    await cleanup();
  }
});

// ---------- Debugger ----------

function command(method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function enableRecording() {
  await command("Network.enable", { maxPostDataSize: 65536 });
  await command("Runtime.enable");
  await command("Log.enable");
  await command("Page.enable");
  await command("Runtime.addBinding", { name: BINDING_NAME });
  // Runs before the page's own scripts on every future load...
  await command("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT });
  // ...and right now on the page that is already open
  await command("Runtime.evaluate", { expression: PAGE_SCRIPT });
}

async function pageInfo() {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: hideSecrets(tab.url || ""), title: hideSecrets(tab.title || "") };
  } catch {
    return { url: "", title: "" };
  }
}

async function readPage() {
  const { result } = await command("Runtime.evaluate", {
    expression: `JSON.stringify({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, ${MAX_PAGE_TEXT}) })`,
    returnByValue: true
  });
  const page = JSON.parse(result.value);
  return {
    title: hideSecrets(page.title),
    url: hideSecrets(page.url),
    text: hideSecrets(page.text)
  };
}

// ---------- WebSocket ----------

function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function sendMessage(message) {
  if (isConnected()) socket.send(JSON.stringify(message));
}

function connect() {
  if (tabId === null || socket) return;

  const ws = new WebSocket(SERVER_URL);
  socket = ws;
  greeted = false;

  ws.onopen = async () => {
    const page = await pageInfo();
    if (socket !== ws) return;
    sendMessage({ type: "HELLO", recording: true, page });
    greeted = true; // events wait until HELLO is out, so the server sees it first
    flush();
  };

  ws.onmessage = async (message) => {
    let request;
    try {
      request = JSON.parse(message.data);
    } catch {
      return;
    }
    if (request?.type !== "REQUEST") return;

    try {
      if (request.method !== "getPage") throw new Error(`Unknown method: ${request.method}`);
      sendMessage({ type: "RESPONSE", id: request.id, result: await readPage() });
    } catch (err) {
      sendMessage({ type: "RESPONSE", id: request.id, error: err.message });
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
  };

  ws.onerror = () => {}; // onclose follows; the reconnect timer retries
}

function flush() {
  while (isConnected() && greeted && queue.length) {
    sendMessage({ type: "EVENTS", events: queue.splice(0, BATCH_SIZE) });
  }
}

function startTimers() {
  stopTimers();
  flushTimer = setInterval(flush, FLUSH_MS);
  reconnectTimer = setInterval(connect, RECONNECT_MS);
  connect();
}

function stopTimers() {
  clearInterval(flushTimer);
  clearInterval(reconnectTimer);
}

// ---------- Start / stop ----------

async function setBadge(id, on) {
  try {
    await chrome.action.setBadgeText({ tabId: id, text: on ? "REC" : "" });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId: id, color: "#dc2626" });
  } catch {
    // The tab is already closed
  }
}

async function start(newTabId) {
  await ready;
  if (tabId !== null) await stop();

  // Throws on pages Chrome does not allow debugging (chrome://, Web Store, ...)
  await chrome.debugger.attach({ tabId: newTabId }, PROTOCOL_VERSION);
  tabId = newTabId;
  queue = [];
  eventCount = 0;
  recorder.reset();

  try {
    await enableRecording();
  } catch (err) {
    await stop();
    throw err;
  }

  await chrome.storage.session.set({ tabId });
  await setBadge(tabId, true);
  sendMessage({ type: "SESSION_START", page: await pageInfo() });
  startTimers();
}

// Forget the recording without touching the debugger (it may already be gone)
async function cleanup() {
  const id = tabId;
  tabId = null;
  queue = [];
  eventCount = 0;
  recorder.reset();
  stopTimers();
  await chrome.storage.session.remove("tabId");
  if (id !== null) await setBadge(id, false);

  if (socket) {
    sendMessage({ type: "SESSION_STOP" });
    socket.close();
    socket = null;
  }
}

async function stop() {
  await ready;
  const id = tabId;
  await cleanup();
  if (id !== null) {
    try {
      await chrome.debugger.detach({ tabId: id });
    } catch {
      // Already detached
    }
  }
}

// ---------- Events ----------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  recorder.handle(method, params);
});

// The user closed the tab or dismissed Chrome's "is debugging this browser" bar
chrome.debugger.onDetach.addListener(async (source) => {
  await ready;
  if (source.tabId === tabId) await cleanup();
});

// Chrome clears the badge when the tab navigates
chrome.tabs.onUpdated.addListener(async (id, changeInfo) => {
  await ready;
  if (id === tabId && changeInfo.status === "complete") await setBadge(id, true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let task = null;
  if (message.action === "START") task = start(message.tabId);
  if (message.action === "STOP") task = stop();
  if (message.action === "GET_STATE") task = ready;
  if (!task) return false;

  task.then(
    () => sendResponse({ ok: true, recordingTabId: tabId, connected: isConnected(), eventCount }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // keep the channel open for the async response
});
