# Telegraph REST API Client

**A fast, fully offline REST API client for VS Code.** Test HTTP APIs without leaving your editor — no account, no sign-in, no API key, no premium tier. Every feature works locally, and your data never leaves your machine.

A free and open-source alternative to Postman and Thunder Client, built as a lightweight VS Code extension.

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/riturajshakti.telegraph-rest-api-client.svg?color=7c5cff)](https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client)
[![Installs](https://vsmarketplacebadges.dev/installs-short/riturajshakti.telegraph-rest-api-client.svg?color=7c5cff)](https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client)
[![Open VSX](https://img.shields.io/open-vsx/v/riturajshakti/telegraph-rest-api-client?label=Open%20VSX&color=7c5cff)](https://open-vsx.org/extension/riturajshakti/telegraph-rest-api-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.txt)

![Telegraph REST API Client](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/api-request.png)

## Install

**[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client)** — or search `Telegraph` in the Extensions panel.

Using Cursor, Antigravity, Windsurf, VSCodium, or Gitpod? Install from
**[Open VSX](https://open-vsx.org/extension/riturajshakti/telegraph-rest-api-client)**.

```sh
code --install-extension riturajshakti.telegraph-rest-api-client
```

---

## Why Telegraph

- **Genuinely free** — no paid plans, no request limits, no locked features
- **Fully offline** — no telemetry, no cloud sync, no account required
- **Tiny** — a ~79 KB download with **zero runtime dependencies**
- **Native feel** — follows your VS Code theme, light or dark
- **Your data is yours** — collections are plain, readable JSON you can commit to git

---

## Features

### Requests

- All standard methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
- Query parameters and headers with per-row enable/disable and drag-to-reorder
- Body types: **JSON**, **XML**, **Text**, **GraphQL**, **Form Data** (with file upload), **Form URL Encoded**, and **Binary**
- Auth: **Basic** and **Bearer**, with `{{variable}}` support
- Cookies tab for sending cookies — including `HttpOnly`, since requests bypass the browser cookie jar
- Syntax highlighting for JSON, XML, and GraphQL, with familiar editor shortcuts
- Paste a JavaScript object and it converts to JSON automatically
- `//` comments allowed in JSON bodies, stripped before sending

![Sending a request](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/api-request.png)

Bearer and Basic auth accept `{{variables}}` like anything else:

![Auth with variables](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/auth.png)

Cookies are sent as a single `Cookie` header, so `HttpOnly` values work here:

![Request cookies](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/cookies.png)

GraphQL gets its own query and variables editors, both with folding and
formatting:

![GraphQL body](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/graphql.png)

Form URL Encoded, with the response highlighted by content type:

![Form URL encoded](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/form-encoded.png)

Form Data fields take a file path, and uploads report real progress:

![File upload progress](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/form-data.png)

### Responses

- Status, timing, and response size
- Syntax-highlighted body: JSON, XML, HTML, CSS, JavaScript
- Collapse and expand regions in JSON, XML, HTML, and GraphQL
- Find in response, with match case, whole word, and regex
- Response headers with one-click copy-all
- Cookies tab showing every `Set-Cookie` with its attributes

![Response headers](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/response-headers.png)

Every `Set-Cookie` is broken out with its attributes, and any of them can be sent back with the next request:

![Response cookies](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/response-cookies.png)

### Streaming responses

Server-sent events and NDJSON render as they arrive instead of waiting for the
stream to close. The newest chunk is highlighted as it lands, with a live event
count and byte total, and **Cancel request** stops an endless stream at any time.

![Streaming SSE](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/sse.png)

### Redirects

Turn on **Follow Redirects** and every hop is listed with its status, method,
timing, and any `Set-Cookie` it sent — including where a `POST` was downgraded
to a `GET`. The Activity list keeps a run count for requests you send repeatedly.

![Redirect chain and activity](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/redirect-and-activity.png)

### Raw request view

The **Raw** tab shows the exact bytes Telegraph will put on the wire — the real
multipart boundary, the computed `Content-Length`, and a hex dump of binary
parts. Edit it and choose **Apply to request** to push changes back into the
other tabs.

![Raw request bytes](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/raw-form-data.png)

### Collections

- Nested folders, saved as human-readable JSON
- Drag to reorder or move between collections; hold <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> while dragging to copy
- Duplicate any request, folder, or collection
- Search across request names and URLs

![Collection actions](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/collection-options.png)

### Environments

- Standalone environments shared across collections
- **Or embed an environment directly inside a collection** — it travels with the collection when exported
- Import variables from a `.env` file, and reload them from disk on demand
- `{{variable}}` works everywhere: URL, query, headers, body, and auth
- Variables that resolve show green with their value on hover; undefined ones show red
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + click a variable to jump straight to where it is defined

![Environments](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/environment.png)

A collection can use no environment, embed its own, or link shared ones:

![Linked environments](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/linked-environment.png)

### Import and export

| Format | Import | Export |
|---|:---:|:---:|
| Telegraph (collection **and** environments in one file) | ✅ | ✅ |
| Postman v2.1 collection | ✅ | ✅ |
| Postman environment | ✅ | ✅ |
| OpenAPI 3 / Swagger 2 (JSON) | ✅ | — |
| cURL | ✅ | ✅ |
| `.env` file | ✅ | ✅ |

![Export format](https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/export-collection.png)

Migrating from Postman? Export your collection and import the file directly —
folder structure, headers, auth, and bodies are all preserved.

Coming from Thunder Client, export to Postman format first; a native Thunder
Client importer is planned.

### Activity

Ad-hoc requests are tracked automatically with status and timing. Re-running a request updates its existing entry rather than filling the list with duplicates.

---

## How Telegraph compares

|  | Telegraph | Thunder Client | Postman |
|---|---|---|---|
| Free requests per collection | Unlimited | 15 (free tier) | Unlimited |
| Works offline | Yes | Partly | No — account required |
| Account / sign-in | Never | Required for paid tier | Required |
| Telemetry | None | Yes | Yes |
| Runs inside VS Code | Yes | Yes | Separate app |
| Collections in git | Plain JSON | Proprietary | Cloud-synced |
| Open source | MIT | No | No |
| Download size | ~79 KB | ~10 MB | ~200 MB app |

Telegraph deliberately does **not** try to match Postman feature for feature.
There is no test scripting, no request chaining, and no team sync — if you need
those, Postman is the better tool. What Telegraph does is send HTTP requests
from your editor, quickly, without asking anything of you.

---

## Getting started

1. Install the extension
2. Click the **Telegraph** icon in the Activity Bar
3. Hit **New Request**, enter a URL, and press **Send**

Paste a cURL command into the URL bar and Telegraph fills in the method, headers, query, body, and auth for you.

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Send request | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> |
| Save request | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd> |
| New request | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>N</kbd> |
| Toggle comment (body editor) | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>/</kbd> |
| Indent / outdent | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>]</kbd> / <kbd>[</kbd> |
| Duplicate line | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> |
| Delete line | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> |
| Move line up / down | <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `telegraph.requestTimeout` | `0` | Request timeout in milliseconds. `0` means no timeout |
| `telegraph.followRedirects` | `true` | Follow HTTP redirects (up to 1000 hops) |
| `telegraph.responseLimit` | `2` | Maximum response size to render, in MB |
| `telegraph.indentSize` | `2` | Indentation used when formatting JSON |

---

## Where your data lives

Collections, environments, and activity are stored as plain JSON in VS Code's global storage:

```
collections/    one file per collection
environments/   one file per environment
history.json    recent activity
```

Every file is human-readable and safe to keep in version control. Nothing is ever uploaded anywhere.

> **A note on secrets:** environments often hold tokens and passwords. If you commit them to a repository, treat that repository as sensitive.

---

## Privacy

Telegraph collects **no telemetry** and makes **no network requests of its own**. The only requests it sends are the ones you ask it to.

---

## License

MIT — see [LICENSE.txt](LICENSE.txt).
