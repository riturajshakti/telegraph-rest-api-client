# Change Log

All notable changes to **Telegraph REST API Client** are documented here.

This project follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.2.0] — 2026-09-11

### Added

- **WebSocket and Socket.IO support.** A response of `101 Switching Protocols`
  opens a live connection: a Socket tab in the request section to send
  messages, another in the response section with a timestamped log of every
  frame, and a button to close the connection. `ws://` and `wss://` URLs work
  directly, as do pasted cURL commands with upgrade headers. Socket.IO is
  detected automatically — Engine.IO heartbeats are answered and the default
  namespace is joined, and an Event field builds the frame for you
- **Binary responses** (images, video, audio, PDF, archives, fonts, Office
  files, wasm and more) now stop at the headers and offer a byte-exact download
  or a text preview, instead of rendering as junk. Downloads stream straight to
  disk with progress, and the headers, cookies, redirects, and Raw tabs stay
  available while they run
- **Export all and import all.** Every collection, environment, and the
  activity list can be written to a timestamped folder and restored from it
- **Invalid body warnings.** JSON, XML, GraphQL queries, and GraphQL variables
  are checked as you type, with the problem and its line and column shown above
  the editor; clicking the position selects the offending character.
  `//` comments and `{{variables}}` are understood and never reported
- **Hex switches in both Raw tabs** — one for a hex dump instead of decoded
  text, one for the offset column and ASCII gutter. Uploads and binary
  responses preview their first 64 KB
- A Raw tab in the response section, showing the status line, headers, and body
  exactly as they arrived
- An open button on each row of the environment list

### Changed

- `telegraph.responseLimit` now accepts `0`, and defaults to it, so large
  responses render in full
- New settings: `telegraph.binaryTextLimit` (default 2 MB, max 20),
  `telegraph.rawHexView`, and `telegraph.rawHexOffsets`
- "Reload Data" is now "Reload Data From Disk", which is what it does
- Word wrap is always on in the Raw tabs

### Fixed

- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd> saves instead of opening a file
  dialog and discarding unsaved edits, on both global and collection
  environment pages
- Undo and redo keep working after editor commands such as word delete,
  comment, indent, move line, and delete line
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> duplicates
  the line again instead of selecting the word
- Selecting text with the mouse inside a key/value field no longer starts a row
  drag, in query, headers, cookies, form, form-encode, and environment tables
- The body, Raw, GraphQL variables, and socket editors no longer show a grey
  block behind every line of text
- The blinking cursor is visible in the body editors again
- <kbd>Option</kbd>/<kbd>Ctrl</kbd> + <kbd>Backspace</kbd> and
  <kbd>Cmd</kbd> + <kbd>Backspace</kbd> delete by word and to the line start,
  matching VS Code on each platform
- Double-click and drag selection work in long bodies
- The Raw editor's scrollbar can be dragged
- Cancelling a download no longer freezes the response view, and the partial
  file is removed
- Binary responses are never truncated by the render limit, which could produce
  a corrupt file on download
- Several files can be imported at once, instead of only the first one selected
- The cURL button no longer clears the clipboard when the URL is empty
- Byte counts group digits the same way on every machine, instead of following
  the host locale

### Improved

- A toast confirms every copy action: response body, headers, redirect chain,
  raw request, and cURL
- The Raw tab moved after Redirects, and the dotfile hint now sits behind an
  info icon next to "Import from .env file" instead of taking up a banner
- The sidebar scrolls past its last row, so the bottom item is no longer
  pinned to the edge
- "Value or file path" is now "Value or file" in form data rows

## [0.1.1] — 2026-09-06

### Changed

- The extension icon now uses the app's purple accent colour instead of orange

## [0.1.0] — 2026-09-06

First public release.

### Requests

- All standard HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
- Query parameters and headers with per-row enable/disable and drag-to-reorder
- Body types: JSON, XML, Text, GraphQL, Form Data (with file upload), Form URL Encoded, Binary
- Basic and Bearer auth, both variable-aware
- Request Cookies tab, combined into a single `Cookie` header on send
- Syntax highlighting for JSON, XML, and GraphQL
- `//` comments supported in JSON bodies and stripped before sending
- Pasting a JavaScript object into a JSON body converts it to valid JSON
- Pasting a cURL command into the URL bar fills in the whole request
- Editor shortcuts: comment toggle, indent/outdent, duplicate line, delete line, move line
- Auto-closing brackets and XML tags

### Responses

- Status, timing, and response size
- Syntax highlighting for JSON, XML, HTML, CSS, and JavaScript
- Collapse and expand regions in JSON, XML, HTML, and GraphQL
- Find in response, with match case, whole word, and regular expressions
- Copy the whole response body or all headers at once
- Response Cookies tab with every `Set-Cookie` attribute, editable and re-sendable
- Upload progress for file bodies
- Cancel an in-flight request

### Streaming

- Server-sent events and NDJSON render chunk by chunk as they arrive
- Live event count and byte total while the stream is open
- The newest chunk is briefly highlighted so new data is visible
- Cancel stops an endless stream at any time

### Redirects

- **Follow Redirects** switch in the request section, up to 1000 hops
- Redirects tab listing every hop with status, method, timing, and `Set-Cookie`
- Hops where a `POST` was downgraded to a `GET` are called out

### Raw request

- Raw tab showing the exact bytes to be sent, including the real multipart
  boundary, computed `Content-Length`, and a hex dump of binary parts
- Edit the raw request and apply it back to the other tabs

### Collections

- Nested folders stored as human-readable JSON
- Drag to reorder, move between collections, or hold `Ctrl`/`Cmd` to copy
- Auto-scroll and auto-expand while dragging
- Duplicate requests, folders, and collections
- Search by request name or URL

### Environments

- Standalone environments shared across collections
- Environments embedded inside a collection, exported alongside it
- Convert between embedded and linked in either direction
- Import variables from a `.env` file, with validation and reload-from-disk
- `{{variable}}` resolution in URL, query, headers, body, and auth, including nested variables
- Defined variables highlight green and show their value and source on hover; undefined ones highlight red
- `Ctrl`/`Cmd` + click a variable to open where it is defined

### Import and export

- **Telegraph** format: one file containing a collection and its environments
- **Postman v2.1**: collections and environments, both directions
- **OpenAPI 3 / Swagger 2** (JSON) import
- **cURL** import and export, including multipart file uploads
- **.env** import and export

### Activity

- Automatic history of ad-hoc requests with status and timing
- Re-running a request updates its existing entry instead of adding a duplicate,
  with a run count shown alongside it
- Save any entry into a collection

### Under the hood

- Zero runtime dependencies; the HTTP engine is built on Node's own `http`/`https`
- Around 75 KB packaged
- No telemetry and no network calls beyond the requests you send

[0.1.1]: https://github.com/riturajshakti/telegraph-rest-api-client/releases/tag/v0.1.1
[0.1.0]: https://github.com/riturajshakti/telegraph-rest-api-client/releases/tag/v0.1.0
