# Change Log

All notable changes to **Telegraph REST API Client** are documented here.

This project follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

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

[0.1.0]: https://github.com/riturajshakti/telegraph-rest-api-client/releases/tag/v0.1.0
