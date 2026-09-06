# Telegraph test server

A local echo server for exercising every feature of the Telegraph REST API
Client. Each endpoint reflects back everything it received — method, query,
headers, cookies, and body — so you can confirm the client actually sent what
you configured.

```sh
cd server
npm install
npm start          # http://localhost:4000
npm test           # 90 automated checks against every endpoint
```

`GET /` lists every route.

> **Tip:** paste any cURL command below straight into the Telegraph URL bar —
> it fills in the method, URL, headers, body, and auth for you.

---

## Every response looks like this

```jsonc
{
  "ok": true,
  "method": "POST",
  "path": "/api/echo",
  "query": { "page": "2" },
  "headers": { "content-type": "application/json", ... },
  "cookies": { "sid": "abc123" },
  "contentType": "application/json",
  "contentLength": 38,
  "body": { "name": "Rituraj" },
  "receivedAt": "2026-09-06T02:43:42.000Z"
}
```

Compare `body`, `headers`, `query`, and `cookies` against what you configured.

---

## 1. HTTP methods

```sh
# GET with query params
curl --request GET \
  'http://localhost:4000/api/echo?page=2&limit=10' \
  --header 'X-Trace: abc123'

# POST — returns 201
curl --request POST \
  'http://localhost:4000/api/echo' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Rituraj","role":"admin"}'

# PUT with a path parameter
curl --request PUT \
  'http://localhost:4000/api/echo/42' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Updated"}'

# PATCH
curl --request PATCH \
  'http://localhost:4000/api/echo/42' \
  --header 'Content-Type: application/json' \
  --data '{"role":"editor"}'

# DELETE
curl --request DELETE 'http://localhost:4000/api/echo/42'

# HEAD — headers only
curl --request HEAD --include 'http://localhost:4000/api/echo'

# OPTIONS — returns 204 with an Allow header
curl --request OPTIONS --include 'http://localhost:4000/api/echo'
```

## 2. Body types

```sh
# JSON — nested objects and arrays round-trip
curl --request POST \
  'http://localhost:4000/api/body/json' \
  --header 'Content-Type: application/json' \
  --data '{"id":1,"tags":["a","b"],"nested":{"ok":true}}'

# XML — returned verbatim, with parsed tag names
curl --request POST \
  'http://localhost:4000/api/body/xml' \
  --header 'Content-Type: application/xml' \
  --data '<user><name>Rituraj</name></user>'

# Plain text
curl --request POST \
  'http://localhost:4000/api/body/text' \
  --header 'Content-Type: text/plain' \
  --data 'hello from telegraph'

# Form URL encoded
curl --request POST \
  'http://localhost:4000/api/body/form-encoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=read write'

# Multipart form data — text fields plus a file
curl --request POST \
  'http://localhost:4000/api/body/form-data' \
  --form 'title=My upload' \
  --form 'category=video' \
  --form 'file=@/path/to/your/file.mp4'

# Binary body
curl --request POST \
  'http://localhost:4000/api/body/binary' \
  --header 'Content-Type: application/octet-stream' \
  --data-binary '@/path/to/your/file.bin'
```

**Checking a JSON body with `//` comments:** type comments in the Telegraph
JSON editor and send to `/api/body/json`. If the response has `"isValidJson":
true` and your fields under `body`, the comments were stripped correctly.

**Checking a file upload:** the response lists `files[]` with `originalName`,
`mimeType`, and `bytes`. Compare `bytes` against the real file size.

## 3. Headers

```sh
curl --request GET \
  'http://localhost:4000/api/headers' \
  --header 'X-Custom: hello' \
  --header 'X-Request-Id: 12345' \
  --header 'Accept: application/json'
```

Returns `customHeaders` with everything except the ones Node adds itself, plus
the `userAgent` it saw.

## 4. Cookies

```sh
# Send cookies
curl --request GET \
  'http://localhost:4000/api/cookies' \
  --header 'Cookie: sid=abc123; theme=dark'

# Receive cookies — sets three, including HttpOnly and Secure
curl --request POST --include 'http://localhost:4000/api/cookies/set'
```

Use the second one to check Telegraph's **response** Cookies tab: it sets
`session_id` (HttpOnly), `theme` (with Max-Age), and `tracking` (Secure +
SameSite=Strict).

## 5. Auth

```sh
# Bearer — 401 without a token
curl --request GET \
  'http://localhost:4000/api/auth/bearer' \
  --header 'Authorization: Bearer my-secret-token'

# Basic — 401 without credentials
curl --request GET \
  'http://localhost:4000/api/auth/basic' \
  --user 'admin:secret123'
```

Both echo back what they decoded, so you can confirm Telegraph's Auth tab
produced the right header.

## 6. Status codes, redirects, timing

```sh
# Any status you like
curl --include 'http://localhost:4000/api/status/404'
curl --include 'http://localhost:4000/api/status/500'
curl --include 'http://localhost:4000/api/status/204'    # no body

# Redirect chain — three hops
curl --location 'http://localhost:4000/api/redirect/3'

# Redirect that accepts POST — the first hop downgrades to GET
curl --request POST --location 'http://localhost:4000/api/redirect/2' \
  --header 'Content-Type: application/json' --data '{"a":1}'

# 303 — always becomes a GET without a body on the next hop
curl --request POST --location 'http://localhost:4000/api/redirect-303' \
  --header 'Content-Type: application/json' --data '{"a":1}'

# Slow response — good for testing Cancel
curl 'http://localhost:4000/api/delay/3000'
```

Turn on **Follow Redirects** in the response section and open the **Redirects**
tab to see each hop, its status, how long it took, any `Set-Cookie` it sent, and
where the method changed.

## 6b. Server-sent events

```sh
# Five events, half a second apart
curl --no-buffer 'http://localhost:4000/api/sse'

# Three events, faster
curl --no-buffer 'http://localhost:4000/api/sse?count=3&interval=200'
```

Each event is named `tick` and carries a JSON payload with `seq`, `of`,
`message`, and `sentAt`. After the last tick the server sends a `done` event and
closes the stream. `count` is clamped to 1-100 and `interval` to 10-10000 ms.

```sh
# Never stops — runs until you cancel it
curl --no-buffer 'http://localhost:4000/api/sse/endless'

# Faster ticks
curl --no-buffer 'http://localhost:4000/api/sse/endless?interval=100'
```

The endless stream sends no `done` event and never closes on its own. Its
payload carries `seq` and `elapsedMs` so you can see it climbing. Use it to
check that the response keeps rendering over time and that **Cancel** stops it —
the server clears its timers as soon as the client disconnects.

## 7. Response content types

These exercise response syntax highlighting:

```sh
curl 'http://localhost:4000/api/response/html'
curl 'http://localhost:4000/api/response/xml'
curl 'http://localhost:4000/api/response/css'
curl 'http://localhost:4000/api/response/js'
curl 'http://localhost:4000/api/response/text'
curl 'http://localhost:4000/api/response/large?rows=2000'   # big payload
```

## 8. GraphQL

Endpoint: `POST http://localhost:4000/graphql`

In Telegraph, choose the **GraphQL** body tab and put the query and variables in
their own editors.

```sh
# Simple query
curl --request POST \
  'http://localhost:4000/graphql' \
  --header 'Content-Type: application/json' \
  --data '{"query":"{ hello }"}'

# Query with variables
curl --request POST \
  'http://localhost:4000/graphql' \
  --header 'Content-Type: application/json' \
  --data '{"query":"query GetUser($id: String!) { user(id: $id) { id name email age } }","variables":{"id":"1"}}'

# List with a filter variable
curl --request POST \
  'http://localhost:4000/graphql' \
  --header 'Content-Type: application/json' \
  --data '{"query":"query List($minAge: Int) { users(minAge: $minAge) { name age } }","variables":{"minAge":30}}'

# Mutation
curl --request POST \
  'http://localhost:4000/graphql' \
  --header 'Content-Type: application/json' \
  --data '{"query":"mutation Add($name: String!, $age: Int) { createUser(name: $name, age: $age) { id name age } }","variables":{"name":"New Person","age":25}}'
```

### Schema

```graphql
type User {
  id: String!
  name: String
  email: String
  age: Int
}

type Query {
  hello: String
  user(id: String!): User
  users(minAge: Int): [User]
}

type Mutation {
  createUser(name: String!, email: String, age: Int): User
}
```

Requesting an unknown field returns a GraphQL `errors` array, which is useful
for checking how Telegraph renders error responses.

---

## Suggested manual test pass

1. **Methods** — send each of the seven to `/api/echo`; confirm `method` matches
2. **Query** — add params in the Query tab; confirm they appear under `query`
3. **Headers** — add custom headers; confirm they appear under `customHeaders`
4. **Cookies** — add cookies in the Cookies tab; confirm `cookiesReceived`
5. **Auth** — try Bearer and Basic; confirm `authenticated: true`
6. **Each body type** — send to its `/api/body/*` route and compare the echo
7. **File upload** — check `files[].bytes` matches the real file size
8. **Response cookies** — `POST /api/cookies/set`, then open the Cookies tab
9. **Redirects** — `/api/redirect/3` and check the Redirects tab; try
    `/api/redirect-303` with a POST body to see the method change
10. **Cancel** — `/api/delay/10000`, then press Cancel
11. **Highlighting** — try each `/api/response/*` route
12. **GraphQL** — run a query with variables, then a mutation
13. **SSE** — `/api/sse?count=3&interval=500` and watch the events arrive
14. **Endless SSE** — `/api/sse/endless`, confirm it keeps streaming, then Cancel

## Notes

- Dependencies here are dev-only. The extension itself still ships with **zero
  runtime dependencies**.
- Change the port with `PORT=5000 npm start`.
- Uploads are held in memory and discarded, so nothing is written to disk.
