/**
 * Telegraph test server
 * =====================
 *
 * A local echo server for exercising every feature of the Telegraph REST API
 * Client. Each endpoint reflects back everything it received — method, query,
 * headers, cookies, and body — so you can confirm the client transmitted it.
 *
 *   npm install
 *   npm start          # http://localhost:4000
 *
 * Every route below carries a cURL example you can paste straight into the
 * Telegraph URL bar, which will fill in the whole request for you.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createHandler } = require('graphql-http/lib/use/express');
const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
} = require('graphql');

const PORT = Number(process.env.PORT) || 4000;
const app = express();

/* ------------------------------------------------------------------ *
 * Parsers — every body type Telegraph can send
 * ------------------------------------------------------------------ */

app.use(cookieParser());
app.use(express.json({ limit: '50mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ limit: '50mb', type: ['text/*'] }));
app.use(express.text({ limit: '50mb', type: ['application/xml', 'text/xml'] }));
app.use(express.raw({ limit: '50mb', type: ['application/octet-stream'] }));

const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Everything the server saw, so the client can be verified end to end. */
function describe(req, extra = {}) {
  const contentType = req.get('content-type') || null;

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    body = {
      encoding: 'binary',
      bytes: body.length,
      preview: body.subarray(0, 64).toString('base64'),
    };
  } else if (body && typeof body === 'object' && Object.keys(body).length === 0) {
    body = null;
  }

  return {
    ok: true,
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    cookies: req.cookies,
    contentType,
    contentLength: req.get('content-length')
      ? Number(req.get('content-length'))
      : 0,
    body,
    receivedAt: new Date().toISOString(),
    ...extra,
  };
}

function log(req, _res, next) {
  console.log(`  ${req.method.padEnd(7)} ${req.originalUrl}`);
  next();
}
app.use(log);

/* ================================================================== *
 * 1. HTTP METHODS
 * ================================================================== */

/*
HEAD /api/echo — headers only, no body by definition. Registered before the
GET route because Express otherwise answers HEAD from the GET handler.

curl --request HEAD --include 'http://localhost:4000/api/echo'
*/
app.head('/api/echo', (req, res) => {
  res.set('X-Echo-Method', 'HEAD');
  res.set('X-Echo-Query', JSON.stringify(req.query));
  res.status(200).end();
});

/*
GET /api/echo?page=2&limit=10

curl --request GET \
  'http://localhost:4000/api/echo?page=2&limit=10' \
  --header 'X-Trace: abc123'
*/
app.get('/api/echo', (req, res) => res.json(describe(req)));

/*
POST /api/echo

curl --request POST \
  'http://localhost:4000/api/echo' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Rituraj","role":"admin"}'
*/
app.post('/api/echo', (req, res) => res.status(201).json(describe(req)));

/*
PUT /api/echo/:id

curl --request PUT \
  'http://localhost:4000/api/echo/42' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Updated"}'
*/
app.put('/api/echo/:id', (req, res) =>
  res.json(describe(req, { params: req.params }))
);

/*
PATCH /api/echo/:id

curl --request PATCH \
  'http://localhost:4000/api/echo/42' \
  --header 'Content-Type: application/json' \
  --data '{"role":"editor"}'
*/
app.patch('/api/echo/:id', (req, res) =>
  res.json(describe(req, { params: req.params }))
);

/*
DELETE /api/echo/:id

curl --request DELETE 'http://localhost:4000/api/echo/42'
*/
app.delete('/api/echo/:id', (req, res) =>
  res.json(describe(req, { params: req.params, deleted: req.params.id }))
);

/*
OPTIONS /api/echo

curl --request OPTIONS --include 'http://localhost:4000/api/echo'
*/
app.options('/api/echo', (_req, res) => {
  res.set('Allow', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
  res.status(204).end();
});

/* ================================================================== *
 * 2. BODY TYPES
 * ================================================================== */

/*
JSON — also proves `//` comments were stripped before sending.

curl --request POST \
  'http://localhost:4000/api/body/json' \
  --header 'Content-Type: application/json' \
  --data '{"id":1,"tags":["a","b"],"nested":{"ok":true}}'
*/
app.post('/api/body/json', (req, res) => {
  res.json(
    describe(req, {
      bodyType: 'json',
      parsedKeys: req.body ? Object.keys(req.body) : [],
      isValidJson: true,
    })
  );
});

/*
XML — returned verbatim so you can confirm it was not mangled.

curl --request POST \
  'http://localhost:4000/api/body/xml' \
  --header 'Content-Type: application/xml' \
  --data '<user><name>Rituraj</name></user>'
*/
app.post('/api/body/xml', (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  res.json(
    describe(req, {
      bodyType: 'xml',
      raw,
      tags: [...raw.matchAll(/<([\w:.-]+)[\s>]/g)].map((m) => m[1]),
    })
  );
});

/*
Plain text.

curl --request POST \
  'http://localhost:4000/api/body/text' \
  --header 'Content-Type: text/plain' \
  --data 'hello from telegraph'
*/
app.post('/api/body/text', (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  res.json(
    describe(req, { bodyType: 'text', raw, length: raw.length })
  );
});

/*
Form URL encoded.

curl --request POST \
  'http://localhost:4000/api/body/form-encoded' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=read write'
*/
app.post('/api/body/form-encoded', (req, res) => {
  res.json(
    describe(req, {
      bodyType: 'formencoded',
      fields: req.body ?? {},
      fieldCount: Object.keys(req.body ?? {}).length,
    })
  );
});

/*
Multipart form data, text fields and files together.

curl --request POST \
  'http://localhost:4000/api/body/form-data' \
  --form 'title=My upload' \
  --form 'file=@/path/to/file.png'
*/
app.post('/api/body/form-data', upload.any(), (req, res) => {
  res.json(
    describe(req, {
      bodyType: 'formdata',
      fields: req.body ?? {},
      files: (req.files ?? []).map((f) => ({
        fieldName: f.fieldname,
        originalName: f.originalname,
        mimeType: f.mimetype,
        bytes: f.size,
        sha256Preview: f.buffer.subarray(0, 16).toString('hex'),
      })),
      fileCount: (req.files ?? []).length,
    })
  );
});

/*
Binary body.

curl --request POST \
  'http://localhost:4000/api/body/binary' \
  --header 'Content-Type: application/octet-stream' \
  --data-binary '@/path/to/file.bin'
*/
app.post('/api/body/binary', (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.json(
    describe(req, {
      bodyType: 'binary',
      bytes: buf.length,
      firstBytesHex: buf.subarray(0, 16).toString('hex'),
    })
  );
});

/* ================================================================== *
 * 3. HEADERS
 * ================================================================== */

/*
Echoes only the headers you added, filtering out ones Node/Express add.

curl --request GET \
  'http://localhost:4000/api/headers' \
  --header 'X-Custom: hello' \
  --header 'X-Request-Id: 12345' \
  --header 'Accept: application/json'
*/
app.get('/api/headers', (req, res) => {
  const automatic = new Set(['host', 'connection', 'content-length']);
  const custom = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!automatic.has(k)) {
      custom[k] = v;
    }
  }
  res.json(
    describe(req, {
      customHeaders: custom,
      userAgent: req.get('user-agent') ?? null,
      headerCount: Object.keys(custom).length,
    })
  );
});

/* ================================================================== *
 * 4. COOKIES
 * ================================================================== */

/*
Reads the cookies you sent.

curl --request GET \
  'http://localhost:4000/api/cookies' \
  --header 'Cookie: sid=abc123; theme=dark'
*/
app.get('/api/cookies', (req, res) => {
  res.json(
    describe(req, {
      cookiesReceived: req.cookies,
      cookieCount: Object.keys(req.cookies ?? {}).length,
      rawCookieHeader: req.get('cookie') ?? null,
    })
  );
});

/*
Sets cookies, including HttpOnly, so you can inspect the response
Cookies tab.

curl --request POST --include 'http://localhost:4000/api/cookies/set'
*/
app.post('/api/cookies/set', (req, res) => {
  res.cookie('session_id', 'sess_' + Date.now(), {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
  });
  res.cookie('theme', 'dark', { path: '/', maxAge: 86400000 });
  res.cookie('tracking', 'xyz789', {
    path: '/',
    secure: true,
    sameSite: 'Strict',
  });
  res.json(describe(req, { message: 'Three cookies set — check the Cookies tab.' }));
});

/* ================================================================== *
 * 5. AUTH
 * ================================================================== */

/*
Bearer token.

curl --request GET \
  'http://localhost:4000/api/auth/bearer' \
  --header 'Authorization: Bearer my-secret-token'
*/
app.get('/api/auth/bearer', (req, res) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res
      .status(401)
      .json({ ok: false, error: 'Missing or malformed Bearer token' });
  }

  res.json(describe(req, { authType: 'bearer', token, authenticated: true }));
});

/*
Basic auth.

curl --request GET \
  'http://localhost:4000/api/auth/basic' \
  --user 'admin:secret123'
*/
app.get('/api/auth/basic', (req, res) => {
  const header = req.get('authorization') ?? '';

  if (!header.startsWith('Basic ')) {
    return res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="Telegraph"')
      .json({ ok: false, error: 'Missing Basic credentials' });
  }

  const [username, password] = Buffer.from(header.slice(6), 'base64')
    .toString('utf8')
    .split(':');

  res.json(
    describe(req, {
      authType: 'basic',
      username,
      passwordLength: (password ?? '').length,
      authenticated: true,
    })
  );
});

/* ================================================================== *
 * 6. STATUS CODES, REDIRECTS, TIMING
 * ================================================================== */

/*
Any status code you like.

curl --request GET --include 'http://localhost:4000/api/status/404'
*/
app.all('/api/status/:code', (req, res) => {
  const code = Number(req.params.code);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return res.status(400).json({ ok: false, error: 'Status must be 100-599' });
  }
  if (code === 204 || code === 304) {
    return res.status(code).end();
  }
  res.status(code).json(describe(req, { returnedStatus: code }));
});

/*
Redirect chain — /api/redirect/3 hops three times.

curl --request GET --location 'http://localhost:4000/api/redirect/3'
*/
app.all('/api/redirect/:n', (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n <= 0) {
    return res.json(describe(req, { redirectsCompleted: true }));
  }
  res.redirect(302, `/api/redirect/${n - 1}`);
});

/*
303 redirect — forces the follow-up hop to become a GET without a body,
which is what the Redirects tab reports as a method change.

curl --request POST --location 'http://localhost:4000/api/redirect-303' \
  --header 'Content-Type: application/json' --data '{"a":1}'
*/
app.all('/api/redirect-303', (_req, res) => {
  res.redirect(303, '/api/echo');
});

/*
Slow response — useful for the Cancel button and upload progress.

curl --request GET 'http://localhost:4000/api/delay/3000'
*/
app.get('/api/delay/:ms', (req, res) => {
  const ms = Math.min(Number(req.params.ms) || 0, 60000);
  setTimeout(() => res.json(describe(req, { delayedMs: ms })), ms);
});

/*
Server-sent events — streams N messages, then a final "done" event and close.
Each event carries a JSON payload so the client can show it as it arrives.

curl --request GET --no-buffer 'http://localhost:4000/api/sse'
curl --request GET --no-buffer 'http://localhost:4000/api/sse?count=3&interval=200'
*/
app.get('/api/sse', (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 100);
  const interval = Math.min(Math.max(Number(req.query.interval) || 500, 10), 10000);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  res.write(`retry: 3000\n\n`);

  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    const payload = JSON.stringify({
      seq: sent,
      of: count,
      message: `tick ${sent}`,
      sentAt: new Date().toISOString(),
    });
    res.write(`id: ${sent}\n`);
    res.write(`event: tick\n`);
    res.write(`data: ${payload}\n\n`);

    if (sent >= count) {
      clearInterval(timer);
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ ok: true, total: sent })}\n\n`);
      res.end();
    }
  }, interval);

  req.on('close', () => clearInterval(timer));
});

/*
Endless server-sent events — never completes on its own. Use it to check that
streaming keeps rendering over time and that Cancel actually stops it.
The counter keeps climbing until the client disconnects.

curl --request GET --no-buffer 'http://localhost:4000/api/sse/endless'
curl --request GET --no-buffer 'http://localhost:4000/api/sse/endless?interval=100'
*/
app.get('/api/sse/endless', (req, res) => {
  const interval = Math.min(Math.max(Number(req.query.interval) || 1000, 10), 10000);
  const startedAt = Date.now();

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  res.write(`retry: 3000\n\n`);

  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    const payload = JSON.stringify({
      seq: sent,
      elapsedMs: Date.now() - startedAt,
      message: `endless tick ${sent}`,
      sentAt: new Date().toISOString(),
    });
    res.write(`id: ${sent}\n`);
    res.write(`event: tick\n`);
    res.write(`data: ${payload}\n\n`);
  }, interval);

  // A comment frame every 15s keeps idle proxies from closing the connection.
  const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 15000);

  const stop = () => {
    clearInterval(timer);
    clearInterval(keepAlive);
  };

  req.on('close', stop);
  req.on('aborted', stop);
  res.on('error', stop);
});

/* ================================================================== *
 * 7. RESPONSE CONTENT TYPES (for response syntax highlighting)
 * ================================================================== */

/** curl 'http://localhost:4000/api/response/html' */
app.get('/api/response/html', (_req, res) => {
  res.type('html').send(
    `<!DOCTYPE html>
<html>
  <head><title>Telegraph</title></head>
  <body>
    <h1>Hello</h1>
    <p class="intro">HTML response for highlighting.</p>
  </body>
</html>`
  );
});

/** curl 'http://localhost:4000/api/response/xml' */
app.get('/api/response/xml', (_req, res) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <book id="1"><title>Telegraph</title><price>0.00</price></book>
</catalog>`
  );
});

/** curl 'http://localhost:4000/api/response/css' */
app.get('/api/response/css', (_req, res) => {
  res.type('css').send(
    `.telegraph {\n  color: #7c5cff;\n  font-weight: 600;\n}`
  );
});

/** curl 'http://localhost:4000/api/response/js' */
app.get('/api/response/js', (_req, res) => {
  res.type('application/javascript').send(
    `const greet = (name) => {\n  return \`hello \${name}\`;\n};\nexport default greet;`
  );
});

/** curl 'http://localhost:4000/api/response/text' */
app.get('/api/response/text', (_req, res) => {
  res.type('text/plain').send('A plain text response.');
});

/** A larger payload, for testing the response size limit. */
app.get('/api/response/large', (req, res) => {
  const rows = Number(req.query.rows) || 500;
  res.json({
    ok: true,
    rows,
    items: Array.from({ length: rows }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
      description: 'Padding to make the payload larger. '.repeat(4),
    })),
  });
});

/* ================================================================== *
 * 8. GRAPHQL
 * ================================================================== */

const users = [
  { id: '1', name: 'Rituraj', email: 'rituraj@example.com', age: 30 },
  { id: '2', name: 'Asha', email: 'asha@example.com', age: 27 },
  { id: '3', name: 'Vikram', email: 'vikram@example.com', age: 41 },
];

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    age: { type: GraphQLInt },
  },
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'Hello from the Telegraph test server',
      },
      user: {
        type: UserType,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (_root, { id }) => users.find((u) => u.id === id) ?? null,
      },
      users: {
        type: new GraphQLList(UserType),
        args: { minAge: { type: GraphQLInt } },
        resolve: (_root, { minAge }) =>
          minAge === undefined
            ? users
            : users.filter((u) => u.age >= minAge),
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      createUser: {
        type: UserType,
        args: {
          name: { type: new GraphQLNonNull(GraphQLString) },
          email: { type: GraphQLString },
          age: { type: GraphQLInt },
        },
        resolve: (_root, args) => {
          const user = { id: String(users.length + 1), ...args };
          users.push(user);
          return user;
        },
      },
    },
  }),
});

/*
GraphQL endpoint.

Query with variables:
  curl --request POST \
    'http://localhost:4000/graphql' \
    --header 'Content-Type: application/json' \
    --data '{"query":"query GetUser($id: String!) { user(id: $id) { id name email age } }","variables":{"id":"1"}}'

Mutation:
  curl --request POST \
    'http://localhost:4000/graphql' \
    --header 'Content-Type: application/json' \
    --data '{"query":"mutation Add($name: String!) { createUser(name: $name, age: 25) { id name } }","variables":{"name":"New Person"}}'
*/
app.all('/graphql', createHandler({ schema }));

/* ================================================================== *
 * 9. INDEX
 * ================================================================== */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'Telegraph test server',
    hint: 'Every route echoes back what it received. See README.md for cURL examples.',
    endpoints: {
      methods: [
        'GET    /api/echo',
        'POST   /api/echo',
        'PUT    /api/echo/:id',
        'PATCH  /api/echo/:id',
        'DELETE /api/echo/:id',
        'HEAD   /api/echo',
        'OPTIONS /api/echo',
      ],
      bodies: [
        'POST /api/body/json',
        'POST /api/body/xml',
        'POST /api/body/text',
        'POST /api/body/form-encoded',
        'POST /api/body/form-data',
        'POST /api/body/binary',
      ],
      headersAndCookies: [
        'GET  /api/headers',
        'GET  /api/cookies',
        'POST /api/cookies/set',
      ],
      auth: ['GET /api/auth/bearer', 'GET /api/auth/basic'],
      behaviour: [
        'ALL /api/status/:code',
        'ALL /api/redirect/:n',
        'ALL /api/redirect-303',
        'GET /api/delay/:ms',
        'GET /api/sse?count=5&interval=500',
        'GET /api/sse/endless?interval=1000',
      ],
      responseTypes: [
        'GET /api/response/html',
        'GET /api/response/xml',
        'GET /api/response/css',
        'GET /api/response/js',
        'GET /api/response/text',
        'GET /api/response/large?rows=500',
      ],
      graphql: ['ALL /graphql'],
    },
  });
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'No such route',
    path: req.path,
    hint: 'GET / lists every endpoint.',
  });
});

app.use((err, req, res, _next) => {
  console.error('  ! ' + err.message);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message,
    type: err.type ?? null,
  });
});

// Only listen when started directly, so tests can mount the app themselves.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Telegraph test server → http://localhost:${PORT}`);
    console.log(`  GET / lists every endpoint.\n`);
  });
}

module.exports = app;
