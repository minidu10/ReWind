# Rewind

A time-travel debugger for AI coding tools.

A Chrome extension records what happens in one browser tab. A local MCP server
lets your AI assistant (Claude Code, VS Code, Cursor) ask what happened before a
bug: what you clicked, which requests failed, what the console said, and which
line of your source code threw.

Instead of describing a bug to the assistant, you reproduce it and say
"the cart is broken, look at Rewind".

```
> explain_error

Error: #57 [-9.4s] EXCEPTION TypeError: Cannot read properties of undefined (reading 'map') (/assets/app.js:1:30)

Stack:
  at render (src/Cart.jsx:42:10)  [bundle: /assets/app.js:1:30]
      > return items.map((item) => item.name);

What happened in the 15s before it:
#54 [-9.7s] click button#buy "Add to cart"
#55 [-9.6s] POST /api/cart → 500 (120ms)
#56 [-9.5s] page changed: +"Something went wrong"
```

> **Status: early.** The server and the extension's logic are covered by
> automated tests, but the extension has not been run in a real Chrome yet.
> Expect rough edges, and see [Limits](#limits).

## How it works

```
 Chrome tab ──CDP──▶ Rewind extension ──WebSocket──▶ Rewind MCP server ──stdio──▶ your editor's AI
                     (records, masks      127.0.0.1:54322   (rolling timeline,
                      secrets)                               source maps)
```

1. You press **Start recording** in the extension popup. The extension attaches
   Chrome's debugger to that tab and listens to network, console, exception,
   and navigation events. A small script injected into the page reports clicks,
   input changes, form submits, Enter/Escape, SPA route changes, and a text
   summary of visible DOM changes.
2. Secrets are masked in the extension, before anything leaves the browser.
3. Events are sent over a WebSocket to the MCP server your editor started on
   `127.0.0.1:54322`. The server keeps a rolling timeline in memory (the last
   5 minutes, at most 5000 events). Nothing is written to disk.
4. The AI assistant calls MCP tools to read the timeline. Stack frames from
   your bundle are mapped back to the original files through source maps.

## Quick start

Requires Node.js 22 or newer and Chrome 120 or newer.

### 1. Get the code and install the server

```sh
git clone https://github.com/minidu10/ReWind.git
cd ReWind/server
npm install
```

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder of this repo.
4. Pin the Rewind icon to the toolbar.

### 3. Add the MCP server to your editor

Use the absolute path to `server/server.js` on your machine.

**Claude Code**

```sh
claude mcp add rewind -- node /absolute/path/to/ReWind/server/server.js
```

**VS Code** (`.vscode/mcp.json` in your project, or the user-level MCP config)

```json
{
  "servers": {
    "rewind": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ReWind/server/server.js"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "rewind": {
      "command": "node",
      "args": ["/absolute/path/to/ReWind/server/server.js"]
    }
  }
}
```

On Windows, write the path with forward slashes or doubled backslashes, for
example `C:/Users/you/ReWind/server/server.js`.

### 4. Record and ask

1. Open your app (for example `http://localhost:5173`) in Chrome.
2. Click the Rewind icon and press **Start recording**. The popup shows a green
   dot once it is connected to your editor's server.
3. Reproduce the bug.
4. Ask your assistant, for example: *"The add-to-cart button does nothing. Use
   Rewind to find out why and fix it."* After the fix, it can call `check_fix`
   to confirm the error is gone.

While a tab is being recorded, Chrome shows a **"Rewind started debugging this
browser"** bar at the top of the window. That is Chrome's own warning for any
extension that uses the debugger, and it cannot be hidden. **Closing that bar
(or pressing Cancel on it) stops the recording.**

The extension only connects to the server while it is recording. If the server
is not running yet, up to 3000 events are kept in the extension and sent when
it starts.

## Tools

| Tool | Arguments | What it returns |
| --- | --- | --- |
| `get_status` | none | Whether a tab is being recorded, the page, event counts by type, and the last code update. |
| `get_timeline` | `seconds` (30), `types`, `limit` (200) | One line per event, oldest first. |
| `get_errors` | none | Uncaught exceptions, `console.error` calls, browser errors, and failed requests, with the top stack frame mapped to your source. |
| `explain_error` | `id`, `before_seconds` (15) | One error in full: message, mapped stack, request and response if it is a failed request, and everything that happened just before it. Defaults to the latest error. |
| `get_request` | `id` | Method, URL, status, timing, and request and response bodies of one request. |
| `get_page` | none | The current page title, URL, and visible text. |
| `check_fix` | `wait_seconds` (3) | Waits, then lists only the errors since the last page load or hot update (Vite, webpack HMR, Fast Refresh), so the assistant can confirm a fix. |

Each event has a numeric `#id`. Times are relative to now:
`#57 [-9.6s] POST /api/cart → 500 (120ms)` is a request sent 9.6 seconds ago.

Event types: `action` (click, submit, change, key), `navigation` (load, route),
`network`, `console`, `exception`, `log` (browser warnings and errors), `dom`
(text added to or removed from the page).

## Configuration

Environment variables for the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REWIND_WINDOW_SECONDS` | `300` | How many seconds of history to keep. |
| `REWIND_EXTENSION_ID` | not set | Accept connections from this extension ID only (the 32-letter ID on `chrome://extensions`). |
| `REWIND_PORT` | `54322` | For the tests only. The extension always connects to 54322. |

Example for Claude Code:

```sh
claude mcp add rewind -e REWIND_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop -- node /absolute/path/to/ReWind/server/server.js
```

## Privacy and security

Rewind sees everything in the recorded tab, so it is built to keep that on your
machine and out of reach of other software.

- **Local only.** The server listens on `127.0.0.1`. It makes no outbound
  requests except fetching scripts and source maps from `localhost`,
  `127.0.0.1`, `[::1]`, and `*.localhost`; it does not follow redirects.
- **One tab, only while recording.** Nothing is recorded until you press Start,
  and only the tab you chose is recorded.
- **Memory only.** The timeline is never written to disk. It is cleared when
  you stop recording, 30 seconds after the extension disconnects, and when the
  server exits.
- **Secrets are masked in the browser.** JWTs, AWS, GitHub, OpenAI, Stripe,
  Slack, and Google keys, bearer tokens, and secret-looking URL parameters and
  JSON fields (`password`, `token`, `api_key`, ...) are replaced before events
  leave the extension. Values typed into password, card, and one-time-code
  fields are never read.
- **Only the extension can connect.** The WebSocket accepts only
  `chrome-extension://` origins, so a web page cannot connect to it. Set
  `REWIND_EXTENSION_ID` to accept only your copy of the extension.
- **Every message is validated** against a schema; anything else is dropped.

What this does not protect against:

- Masking is pattern-based. A secret in an unusual format, or personal data in
  a response body, will reach your AI assistant and therefore its provider.
  Record a development environment, not a production account.
- Any program running as you on your machine can already read your browser
  data; Rewind does not change that. A local program can also send a forged
  `Origin` header, which is why `REWIND_EXTENSION_ID` narrows the check but is
  not authentication.
- Request headers and cookies are not recorded at all.

## Limits

- **Not yet run in Chrome.** The recorder, page script, and secret masking are
  tested in Node with fake Chrome events, and the server is tested end to end
  with a fake extension. The real extension has not been exercised in a
  browser, so expect bugs there.
- **DOM recording is a text summary**, not a visual replay: up to 10 pieces of
  added and removed text per 400 ms batch. There are no screenshots, no layout
  or style information, and no attribute changes.
- **One tab at a time**, top frame only for page loads. Events inside
  cross-origin iframes and workers are not recorded.
- **One editor at a time.** The port is fixed, so if two editors each start a
  Rewind server, the second one reports that the port is in use and waits.
- **Bodies are cut.** Request and response bodies are kept for fetch/XHR text
  responses only, up to 4000 characters; console text up to 2000; stacks up to
  8 frames. WebSocket messages are not recorded.
- **Source maps** work for apps served from localhost with maps the server can
  fetch (a `sourceMappingURL` comment or `SourceMap` header). If the code
  changed after the error, the mapped line can be off.
- **Chrome may stop the extension's worker** when idle. Recording resumes when
  it restarts, but events from the gap are lost.
- Scripts, images, styles, and fonts are recorded only when they fail.

## Development

```
extension/   Chrome extension (Manifest V3), no build step
  background.js       service worker: debugger, queue, WebSocket
  lib/recorder.js     CDP events → timeline events (pure, tested in Node)
  lib/page-script.js  injected into the page: actions, routes, DOM summary
  lib/secrets.js      masks secrets
  popup.html/js       Start/Stop, status
  test/
server/      MCP server (Node, ES modules)
  server.js           entry point: env vars, stdio transport
  lib/store.js        rolling timeline
  lib/bridge.js       WebSocket server for the extension
  lib/sourcemap.js    bundle frame → original source
  lib/format.js       one line per event
  lib/tools.js        the MCP tools
  test/
```

Run the tests (Node's built-in test runner, no test libraries):

```sh
cd extension && npm test
cd server && npm install && npm test
```

CI runs both suites on Node 22 and 24.

### Protocol

The extension sends JSON over the WebSocket:

| Message | When |
| --- | --- |
| `{type:"HELLO", recording, page:{url,title}}` | on connect |
| `{type:"SESSION_START", page}` | a new recording started |
| `{type:"SESSION_STOP"}` | recording stopped |
| `{type:"EVENTS", events:[{ts, type, data}]}` | batches of up to 200 |
| `{type:"RESPONSE", id, result \| error}` | reply to a server request |

The server sends `{type:"REQUEST", id, method:"getPage"}`.
