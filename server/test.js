/**
 * Exercises every endpoint on the test server and verifies the echoed data
 * matches what was sent.
 *
 *   npm test
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const PORT = Number(process.env.PORT) || 4100;
const BASE = `http://localhost:${PORT}`;

process.env.PORT = String(PORT);
const app = require('./index.js');

const pass = [];
const fail = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  (ok ? pass : fail).push(
    ok
      ? `  ✓ ${label}`
      : `  ✗ ${label}\n      got  ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await delay(15);
  }
  return false;
}

function openSocket(path, { answerPings = false } = {}) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
    const text = [];
    const binary = [];
    let settleClose;
    const closed = new Promise((r) => (settleClose = r));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binary.push(data);
        return;
      }
      const value = data.toString('utf8');
      text.push(value);
      if (answerPings && value === '2') {
        ws.send('3');
      }
    });
    ws.on('close', (code, reason) => settleClose({ code, reason: reason.toString() }));
    ws.once('open', () =>
      resolve({
        ws,
        text,
        binary,
        closed,
        json: () =>
          text
            .map((t) => {
              try {
                return JSON.parse(t);
              } catch {
                return null;
              }
            })
            .filter(Boolean),
      })
    );
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ws: null, status: res.statusCode, text, binary, closed, json: () => [] });
      res.resume();
    });
    ws.once('error', reject);
  });
}

function rawGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port: PORT, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

/**
 * Reads an endless stream until `want` ticks arrive, then hangs up and reports
 * whether the server kept writing afterwards.
 */
function streamEndless(path, want) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: PORT, path, method: 'GET' },
      (res) => {
        let buffer = '';
        const ticks = [];
        let sawDone = false;
        let endedByServer = false;
        let closed = false;
        let afterClose = 0;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (closed) {
            afterClose += 1;
            return;
          }
          buffer += chunk;

          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            let name = null;
            let data = null;
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) name = line.slice(7);
              else if (line.startsWith('data: ')) data = line.slice(6);
            }
            if (name === 'tick' && data) ticks.push(JSON.parse(data));
            if (name === 'done') sawDone = true;

            split = buffer.indexOf('\n\n');
          }

          if (ticks.length >= want && !closed) {
            closed = true;
            req.destroy();
            resolve({
              contentType: res.headers['content-type'] || '',
              ticks,
              sawDone,
              endedByServer,
              ticksAfterClose: () => afterClose,
            });
          }
        });

        res.on('end', () => {
          endedByServer = true;
        });
      }
    );
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

function streamSse(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: PORT, path, method: 'GET' },
      (res) => {
        let buffer = '';
        const arrivals = [];
        const ticks = [];
        const events = [];
        const ids = [];
        let done = null;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          arrivals.push(Date.now());
          buffer += chunk;

          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            let name = null;
            let id = null;
            let data = null;
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) name = line.slice(7);
              else if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('data: ')) data = line.slice(6);
            }

            if (name === 'tick' && data) {
              events.push(name);
              ticks.push(JSON.parse(data));
              if (id !== null) ids.push(id);
            } else if (name === 'done' && data) {
              done = JSON.parse(data);
            }

            split = buffer.indexOf('\n\n');
          }
        });

        res.on('end', () =>
          resolve({
            contentType: res.headers['content-type'] || '',
            arrivals,
            ticks,
            events,
            ids,
            done,
            closed: true,
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: PORT, ...options },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            // not JSON, that is fine
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: raw.toString('utf8'),
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function multipart(fields, files) {
  const boundary = '----TestBoundary' + randomBytes(8).toString('hex');
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  for (const [name, file] of Object.entries(files)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${name}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`
      )
    );
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, buffer: Buffer.concat(parts) };
}

async function run() {
  const server = http.createServer(app);
  app.attachSockets(server, { pingInterval: 300, pingTimeout: 400 });
  server.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  let res;

  /* -------------------------------- methods */
  console.log('\nHTTP methods');

  res = await request({ method: 'GET', path: '/api/echo?page=2&limit=10' });
  check('GET status', res.status, 200);
  check('GET query echoed', res.json.query, { page: '2', limit: '10' });

  res = await request(
    {
      method: 'POST',
      path: '/api/echo',
      headers: { 'content-type': 'application/json' },
    },
    JSON.stringify({ name: 'Rituraj' })
  );
  check('POST status is 201', res.status, 201);
  check('POST body echoed', res.json.body, { name: 'Rituraj' });

  res = await request(
    {
      method: 'PUT',
      path: '/api/echo/42',
      headers: { 'content-type': 'application/json' },
    },
    JSON.stringify({ name: 'Updated' })
  );
  check('PUT params echoed', res.json.params, { id: '42' });
  check('PUT body echoed', res.json.body, { name: 'Updated' });

  res = await request(
    {
      method: 'PATCH',
      path: '/api/echo/42',
      headers: { 'content-type': 'application/json' },
    },
    JSON.stringify({ role: 'editor' })
  );
  check('PATCH body echoed', res.json.body, { role: 'editor' });

  res = await request({ method: 'DELETE', path: '/api/echo/42' });
  check('DELETE echoes id', res.json.deleted, '42');

  res = await request({ method: 'HEAD', path: '/api/echo' });
  check('HEAD status', res.status, 200);
  check('HEAD has no body', res.text, '');
  check('HEAD custom header', res.headers['x-echo-method'], 'HEAD');

  res = await request({ method: 'OPTIONS', path: '/api/echo' });
  check('OPTIONS status', res.status, 204);
  check('OPTIONS Allow header', res.headers.allow.includes('PATCH'), true);

  /* -------------------------------- body types */
  console.log('\nBody types');

  res = await request(
    {
      method: 'POST',
      path: '/api/body/json',
      headers: { 'content-type': 'application/json' },
    },
    JSON.stringify({ id: 1, tags: ['a', 'b'], nested: { ok: true } })
  );
  check('JSON content-type seen', res.json.contentType, 'application/json');
  check('JSON nested preserved', res.json.body.nested, { ok: true });
  check('JSON array preserved', res.json.body.tags, ['a', 'b']);
  check('JSON keys', res.json.parsedKeys, ['id', 'tags', 'nested']);

  res = await request(
    {
      method: 'POST',
      path: '/api/body/xml',
      headers: { 'content-type': 'application/xml' },
    },
    '<user><name>Rituraj</name></user>'
  );
  check('XML raw preserved', res.json.raw, '<user><name>Rituraj</name></user>');
  check('XML tags parsed', res.json.tags, ['user', 'name']);

  res = await request(
    {
      method: 'POST',
      path: '/api/body/text',
      headers: { 'content-type': 'text/plain' },
    },
    'hello from telegraph'
  );
  check('Text preserved', res.json.raw, 'hello from telegraph');
  check('Text length', res.json.length, 20);

  res = await request(
    {
      method: 'POST',
      path: '/api/body/form-encoded',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    },
    'grant_type=client_credentials&scope=read%20write&sym=a%26b'
  );
  check('Form fields parsed', res.json.fields, {
    grant_type: 'client_credentials',
    scope: 'read write',
    sym: 'a&b',
  });
  check('Form field count', res.json.fieldCount, 3);

  const fileData = Buffer.from('binary file contents here');
  const mp = multipart(
    { title: 'My upload', category: 'video' },
    { file: { name: 'clip.mp4', type: 'video/mp4', data: fileData } }
  );
  res = await request(
    {
      method: 'POST',
      path: '/api/body/form-data',
      headers: {
        'content-type': `multipart/form-data; boundary=${mp.boundary}`,
        'content-length': mp.buffer.length,
      },
    },
    mp.buffer
  );
  check('Multipart text fields', res.json.fields, {
    title: 'My upload',
    category: 'video',
  });
  check('Multipart file count', res.json.fileCount, 1);
  check('Multipart filename', res.json.files[0].originalName, 'clip.mp4');
  check('Multipart mime type', res.json.files[0].mimeType, 'video/mp4');
  check('Multipart file bytes', res.json.files[0].bytes, fileData.length);

  const binary = randomBytes(256);
  res = await request(
    {
      method: 'POST',
      path: '/api/body/binary',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': binary.length,
      },
    },
    binary
  );
  check('Binary byte count', res.json.bytes, 256);
  check(
    'Binary contents intact',
    res.json.firstBytesHex,
    binary.subarray(0, 16).toString('hex')
  );

  /* -------------------------------- headers and cookies */
  console.log('\nHeaders and cookies');

  res = await request({
    method: 'GET',
    path: '/api/headers',
    headers: { 'x-custom': 'hello', 'x-request-id': '12345' },
  });
  check('Custom header echoed', res.json.customHeaders['x-custom'], 'hello');
  check(
    'Second header echoed',
    res.json.customHeaders['x-request-id'],
    '12345'
  );

  res = await request({
    method: 'GET',
    path: '/api/cookies',
    headers: { cookie: 'sid=abc123; theme=dark' },
  });
  check('Cookies parsed', res.json.cookiesReceived, {
    sid: 'abc123',
    theme: 'dark',
  });
  check('Cookie count', res.json.cookieCount, 2);

  res = await request({ method: 'POST', path: '/api/cookies/set' });
  const setCookies = res.headers['set-cookie'] ?? [];
  check('Three cookies set', setCookies.length, 3);
  check(
    'HttpOnly flag present',
    setCookies.some((c) => c.includes('HttpOnly')),
    true
  );
  check(
    'Secure flag present',
    setCookies.some((c) => c.includes('Secure')),
    true
  );

  /* -------------------------------- auth */
  console.log('\nAuth');

  res = await request({
    method: 'GET',
    path: '/api/auth/bearer',
    headers: { authorization: 'Bearer my-secret-token' },
  });
  check('Bearer accepted', res.status, 200);
  check('Bearer token echoed', res.json.token, 'my-secret-token');

  res = await request({ method: 'GET', path: '/api/auth/bearer' });
  check('Missing bearer rejected', res.status, 401);

  const basic = Buffer.from('admin:secret123').toString('base64');
  res = await request({
    method: 'GET',
    path: '/api/auth/basic',
    headers: { authorization: `Basic ${basic}` },
  });
  check('Basic accepted', res.status, 200);
  check('Basic username decoded', res.json.username, 'admin');
  check('Basic password length', res.json.passwordLength, 9);

  res = await request({ method: 'GET', path: '/api/auth/basic' });
  check('Missing basic rejected', res.status, 401);

  /* -------------------------------- status, redirect, delay */
  console.log('\nStatus, redirects, timing');

  for (const code of [200, 201, 400, 404, 500]) {
    res = await request({ method: 'GET', path: `/api/status/${code}` });
    check(`Status ${code}`, res.status, code);
  }

  res = await request({ method: 'GET', path: '/api/status/204' });
  check('Status 204 has no body', res.text, '');

  res = await request({ method: 'GET', path: '/api/redirect/2' });
  check('Redirect returns 302', res.status, 302);
  check('Redirect location', res.headers.location, '/api/redirect/1');

  res = await request({ method: 'POST', path: '/api/redirect/2' });
  check('Redirect accepts POST', res.status, 302);

  const pretty = '{\n  "id": 1,\n  "tags": [\n    "a",\n    "b"\n  ],\n  "nested": {\n    "ok": true\n  }\n}';
  res = await request(
    {
      method: 'POST',
      path: '/api/body/json',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(pretty),
      },
    },
    pretty
  );
  check('Pretty JSON byte count', Buffer.byteLength(pretty), 81);
  check('Server sees same length', res.json.contentLength, 81);
  check('Pretty JSON parses', res.json.body.nested.ok, true);

  res = await request({ method: 'GET', path: '/api/redirect/900' });
  check('Long chain still redirects', res.status, 302);
  check('Long chain location', res.headers.location, '/api/redirect/899');

  res = await request({ method: 'POST', path: '/api/redirect-303' });
  check('303 status', res.status, 303);
  check('303 location', res.headers.location, '/api/echo');

  const started = Date.now();
  res = await request({ method: 'GET', path: '/api/delay/300' });
  check('Delay respected', Date.now() - started >= 290, true);
  check('Delay reports ms', res.json.delayedMs, 300);

  /* -------------------------------- server-sent events */
  console.log('\nServer-sent events');

  const sse = await streamSse('/api/sse?count=3&interval=120');
  check('SSE content-type', sse.contentType.includes('text/event-stream'), true);
  check('SSE not chunk-buffered', sse.arrivals.length >= 2, true);
  check('SSE tick count', sse.ticks.length, 3);
  check('SSE sequence order', sse.ticks.map((t) => t.seq), [1, 2, 3]);
  check('SSE reports total', sse.ticks[0].of, 3);
  check('SSE event names', sse.events.slice(0, 3), ['tick', 'tick', 'tick']);
  check('SSE ids present', sse.ids, ['1', '2', '3']);
  check('SSE done event', sse.done, { ok: true, total: 3 });
  check('SSE stream closed', sse.closed, true);

  const capped = await streamSse('/api/sse?count=500&interval=1');
  check('SSE clamps count to 100', capped.ticks.length, 100);

  const defaulted = await streamSse('/api/sse?interval=10');
  check('SSE default count', defaulted.ticks.length, 5);

  const endless = await streamEndless('/api/sse/endless?interval=40', 4);
  check('Endless content-type', endless.contentType.includes('text/event-stream'), true);
  check('Endless keeps sending', endless.ticks.length >= 4, true);
  check('Endless sequence climbs', endless.ticks.map((t) => t.seq).slice(0, 4), [1, 2, 3, 4]);
  check('Endless reports elapsed', typeof endless.ticks[0].elapsedMs, 'number');
  check('Endless never ended itself', endless.endedByServer, false);
  check('Endless sent no done event', endless.sawDone, false);

  await delay(200);
  check('Endless stopped after disconnect', endless.ticksAfterClose(), 0);

  /* -------------------------------- response content types */
  console.log('\nResponse content types');

  res = await request({ method: 'GET', path: '/api/response/html' });
  check('HTML content-type', res.headers['content-type'].includes('text/html'), true);
  check('HTML body', res.text.includes('<h1>Hello</h1>'), true);

  res = await request({ method: 'GET', path: '/api/response/xml' });
  check('XML content-type', res.headers['content-type'].includes('xml'), true);

  res = await request({ method: 'GET', path: '/api/response/css' });
  check('CSS content-type', res.headers['content-type'].includes('css'), true);

  res = await request({ method: 'GET', path: '/api/response/js' });
  check(
    'JS content-type',
    res.headers['content-type'].includes('javascript'),
    true
  );

  res = await request({ method: 'GET', path: '/api/response/large?rows=50' });
  check('Large payload rows', res.json.items.length, 50);

  /* -------------------------------- graphql */
  console.log('\nGraphQL');

  const gql = (query, variables) =>
    request(
      {
        method: 'POST',
        path: '/graphql',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      },
      JSON.stringify({ query, variables })
    );

  res = await gql('{ hello }');
  check('GraphQL hello', res.json.data.hello, 'Hello from the Telegraph test server');

  res = await gql(
    'query GetUser($id: String!) { user(id: $id) { id name email age } }',
    { id: '1' }
  );
  check('GraphQL query with variables', res.json.data.user, {
    id: '1',
    name: 'Rituraj',
    email: 'rituraj@example.com',
    age: 30,
  });

  res = await gql('query List($minAge: Int) { users(minAge: $minAge) { name } }', {
    minAge: 30,
  });
  check(
    'GraphQL list filtered by variable',
    res.json.data.users.map((u) => u.name),
    ['Rituraj', 'Vikram']
  );

  res = await gql(
    'mutation Add($name: String!, $age: Int) { createUser(name: $name, age: $age) { id name age } }',
    { name: 'Test Person', age: 25 }
  );
  check('GraphQL mutation', res.json.data.createUser.name, 'Test Person');
  check('GraphQL mutation age', res.json.data.createUser.age, 25);

  res = await gql('{ nope }');
  check('GraphQL reports errors', Array.isArray(res.json.errors), true);

  /* -------------------------------- index and 404 */
  console.log('\nIndex and errors');

  res = await request({ method: 'GET', path: '/' });
  check('Index lists endpoints', typeof res.json.endpoints, 'object');

  res = await request({ method: 'GET', path: '/no/such/route' });
  check('Unknown route is 404', res.status, 404);
  check('404 is JSON', res.json.ok, false);

  console.log('\nNative WebSocket');

  let a = await openSocket('/ws');
  await until(() => a.json().some((m) => m.type === 'welcome'));
  const welcome = a.json().find((m) => m.type === 'welcome');
  check('WS welcome message', welcome.message, 'Connected to the Telegraph WebSocket echo server');
  check('WS welcome echoes handshake headers', welcome.handshake.headers.upgrade, 'websocket');

  a.ws.send('hello');
  await until(() => a.json().some((m) => m.type === 'echo' && m.data === 'hello'));
  check('WS echoes text', a.json().some((m) => m.type === 'echo' && m.data === 'hello'), true);

  a.ws.send('{"x":1}');
  await until(() => a.json().some((m) => m.type === 'echo' && m.data && m.data.x === 1));
  check('WS echoes JSON parsed', a.json().some((m) => m.type === 'echo' && m.data && m.data.x === 1), true);

  a.ws.send(Buffer.from([1, 2, 3]));
  await until(() => a.binary.length > 0);
  check('WS echoes binary byte for byte', [...(a.binary[0] ?? [])], [1, 2, 3]);

  a.ws.send('{"action":"binary","bytes":16}');
  await until(() => a.binary.length > 1);
  check('WS binary action pattern', [...(a.binary[1] ?? [])].slice(0, 4), [0, 1, 2, 3]);
  check('WS binary action size', (a.binary[1] ?? []).length, 16);

  a.ws.send('{"action":"burst","count":3}');
  await until(() => a.json().filter((m) => m.type === 'burst').length === 3);
  check('WS burst', a.json().filter((m) => m.type === 'burst').map((m) => m.seq), [1, 2, 3]);

  a.ws.send('{"action":"ping"}');
  await until(() => a.json().some((m) => m.type === 'pong'));
  check('WS server ping answered', a.json().find((m) => m.type === 'pong')?.payload, 'telegraph');

  const b = await openSocket('/ws');
  a.ws.send('{"action":"broadcast","data":"hi all"}');
  await until(() => b.json().some((m) => m.type === 'broadcast'));
  check('WS broadcast reaches other clients', b.json().find((m) => m.type === 'broadcast')?.data, 'hi all');
  b.ws.close();

  a.ws.send('{"action":"close","code":4001,"reason":"bye"}');
  const closed = await a.closed;
  check('WS close action', closed, { code: 4001, reason: 'bye' });

  const ticks = await openSocket('/ws?interval=50');
  await until(() => ticks.json().filter((m) => m.type === 'tick').length >= 3);
  check('WS interval ticks', ticks.json().filter((m) => m.type === 'tick').length >= 3, true);
  ticks.ws.close();

  const missing = await openSocket('/nope');
  check('WS unknown path is 404', missing.status, 404);

  res = await request({ method: 'GET', path: '/ws' });
  check('GET /ws without upgrade is 426', res.status, 426);

  console.log('\nSocket.IO');

  const io = await openSocket('/socket.io/?EIO=4&transport=websocket', { answerPings: true });
  await until(() => io.text.length > 0);
  check('IO open packet first', io.text[0][0], '0');
  check('IO ping interval passed through', JSON.parse(io.text[0].slice(1)).pingInterval, 300);

  io.ws.send('40');
  await until(() => io.text.some((t) => t.startsWith('42["welcome"')));
  check('IO connect acknowledged', io.text.some((t) => t.startsWith('40{')), true);
  check('IO welcome event', io.text.some((t) => t.startsWith('42["welcome"')), true);

  io.ws.send('42["message",{"x":1}]');
  await until(() => io.text.some((t) => t.startsWith('42["echo"')));
  const echoed = JSON.parse(io.text.find((t) => t.startsWith('42["echo"')).slice(2));
  check('IO echo event', [echoed[0], echoed[1].event, echoed[1].data], ['echo', 'message', { x: 1 }]);

  io.ws.send('421["message","hi"]');
  await until(() => io.text.some((t) => t.startsWith('431')));
  check('IO ack', JSON.parse(io.text.find((t) => t.startsWith('431')).slice(3))[0].ok, true);

  await delay(900);
  check('IO survives heartbeats', io.ws.readyState, 1);

  io.ws.send('40/admin,{"token":"nope"}');
  await until(() => io.text.some((t) => t.startsWith('44/admin,')));
  check('IO admin rejects a bad token', io.text.some((t) => t.startsWith('44/admin,')), true);

  io.ws.send('40/admin,{"token":"secret-token"}');
  await until(() => io.text.some((t) => t.startsWith('42/admin,["welcome"')));
  check('IO admin accepts the token', io.text.some((t) => t.startsWith('42/admin,["welcome"')), true);

  io.ws.send('42["close-me"]');
  await until(() => io.text.includes('41'));
  check('IO close-me disconnects', io.text.includes('41'), true);

  const polling = await rawGet('/socket.io/?EIO=4&transport=polling');
  check('IO polling handshake', [polling.status, polling.body[0]], [200, '0']);

  server.close();

  console.log('\n' + pass.join('\n'));
  if (fail.length) {
    console.log('\nFAILURES:\n' + fail.join('\n'));
    console.log(`\n${pass.length} passed, ${fail.length} failed`);
    process.exit(1);
  }
  console.log(`\n${pass.length}/${pass.length} passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
