const button = document.getElementById("toggle");
const statusText = document.getElementById("status");
const dot = document.getElementById("dot");
const serverText = document.getElementById("serverText");

let currentTabId = null;
let recordingHere = false;

async function ask(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response ?? { ok: false, error: "Rewind didn't respond. Reload the extension in chrome://extensions." };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function render(state) {
  recordingHere = state.recordingTabId === currentTabId;
  const recordingElsewhere = state.recordingTabId !== null && !recordingHere;

  button.textContent = recordingHere ? "Stop recording" : "Start recording";
  button.classList.toggle("recording", recordingHere);

  if (recordingHere) statusText.textContent = `Recording this tab · ${state.eventCount} events`;
  else if (recordingElsewhere) statusText.textContent = "Recording another tab. Starting here will switch.";
  else statusText.textContent = "Not recording";

  dot.className = "dot" + (state.connected ? " on" : state.recordingTabId !== null ? " waiting" : "");
  if (state.connected) serverText.textContent = "Connected to your editor";
  else if (state.recordingTabId !== null) serverText.textContent = "Waiting for the Rewind MCP server. Events are kept until it starts.";
  else serverText.textContent = "Editor not connected";
}

async function refresh() {
  const state = await ask({ action: "GET_STATE" });
  if (state.ok) render(state);
  else statusText.textContent = state.error;
}

button.addEventListener("click", async () => {
  button.disabled = true;
  const state = await ask(recordingHere ? { action: "STOP" } : { action: "START", tabId: currentTabId });
  button.disabled = false;

  if (state.ok) render(state);
  else statusText.textContent = `Can't record this tab: ${state.error}`;
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  currentTabId = tab.id;
  refresh();
  setInterval(refresh, 1000);
});
