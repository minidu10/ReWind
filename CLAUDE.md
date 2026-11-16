# Rewind

A time-travel debugger for AI coding tools: a Chrome extension records one
browser tab, and a local MCP server lets an AI assistant ask what happened
before a bug. A tool for developers, not a business product.

## Rules

- Minidu is the only contributor. Never add `Co-Authored-By: Claude` to commits
  or "Generated with Claude Code" to pull requests. Commit under the existing
  git identity only.
- Never commit `package-lock.json` or `.vscode/` (both are in `.gitignore`;
  `.npmrc` turns the lock file off). CI installs with `npm install`.
- GitHub push protection blocks key-shaped strings, even fake ones in tests.
  Build fake keys from joined pieces at runtime:
  `["sk_", "live_", "abc..."].join("")`. Do not put key-shaped strings in the
  README either.
- Tests use `node:test` and `node:assert` only. Do not add test libraries.
- Server dependencies are limited to `@modelcontextprotocol/sdk`, `ws`, `zod`,
  and `source-map-js`. The extension has no dependencies and no build step.
- Run both test suites before pushing. Push only when they pass.
- Be honest in the README about what is untested (see "Limits").

## Layout

```
extension/                Chrome extension, Manifest V3, loaded unpacked
  manifest.json           permissions: debugger, storage, tabs
  background.js           service worker: attaches chrome.debugger, queues events,
                          sends them to ws://127.0.0.1:54322, answers "getPage"
  lib/recorder.js         CDP events → {ts, type, data}. No Chrome APIs.
  lib/page-script.js      injected into the page; reports through the
                          "__rewindEvent" binding. Never sends password/card values.
  lib/secrets.js          hideSecrets(): masks keys, tokens, JWTs
  popup.html, popup.js    Start/Stop, event count, server status
  test/                   recorder, page-script, secrets
server/                   MCP server, Node >= 22, ES modules
  server.js               entry: env vars, Store + Bridge + tools, stdio transport
  lib/store.js            rolling timeline (5 min, 5000 events), ids, errors,
                          last code update (page load or HMR console line)
  lib/bridge.js           WebSocket server on 127.0.0.1:54322; origin check,
                          zod validation, clears data on stop / disconnect
  lib/sourcemap.js        maps bundle frames to source; localhost fetches only
  lib/format.js           one compact line per event
  lib/tools.js            get_status, get_timeline, get_errors, explain_error,
                          get_request, get_page, check_fix
  test/                   store, format, sourcemap, bridge, integration
                          (helpers.js is shared, not a test file)
.github/workflows/test.yml  both suites on Node 22 and 24
```

## Commands

```sh
cd extension && npm test
cd server && npm install && npm test
node server/server.js        # speaks MCP on stdio; logs go to stderr
```

## Things to keep true

- stdout of `server.js` is the MCP protocol. Log to stderr only, and never log
  event data.
- The protocol between extension and server is documented in the README. If an
  event shape changes in `recorder.js`, update the zod schema in `bridge.js`,
  `format.js`, and the tests together.
- Timestamps are milliseconds since the epoch; stack `line`/`col` are 1-based.
- Network events are stamped with the time the request was sent, so they
  arrive out of order. The store sorts by `ts`.
- Secrets are masked in the extension, before events are queued. The server
  must not rely on receiving unmasked data.
- The server only fetches from localhost / 127.0.0.1 / [::1] / *.localhost and
  does not follow redirects.
- `REWIND_PORT` exists for tests only; the extension's port is fixed.
- The extension has not been verified in a real Chrome yet. Until it has, treat
  `background.js` and `popup.js` as untested.
