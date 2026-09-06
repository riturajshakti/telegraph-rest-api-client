import type { ApiRequest, HttpMethod, KeyValue } from './types';
import { stripJsonComments } from './jsonc';

const PREVIEW_BOUNDARY = '----TelegraphFormBoundary<generated-at-send>';

declare const btoa: ((input: string) => string) | undefined;
declare const atob: ((input: string) => string) | undefined;

/** Base64 helpers that work in both the webview and the extension host. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(text, 'utf8').toString('base64');
}

function fromBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    const binary =
      typeof atob === 'function'
        ? atob(value)
        : Buffer.from(value, 'base64').toString('binary');
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
};

function mimeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot < 0 ? '' : fileName.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

const METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export interface RawParseResult {
  ok: boolean;
  request?: Partial<ApiRequest>;
  errors: string[];
}

function enabled(items: KeyValue[] | undefined): KeyValue[] {
  return (items ?? []).filter((i) => !i.isDisabled && i.name.trim());
}

/**
 * Renders a request as an HTTP message. Variables are left unresolved so the
 * text round-trips back to the same request.
 */
export interface SentFileInfo {
  name: string;
  fileName: string;
  bytes: number;
  preview?: string;
}

export interface SentBodyInfo {
  boundary?: string;
  files?: SentFileInfo[];
  totalBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function toRawHttp(request: ApiRequest, sent?: SentBodyInfo): string {
  const lines: string[] = [];

  let target = request.url.trim() || '/';
  const query = enabled(request.params).filter((p) => !(p as { isPath?: boolean }).isPath);

  if (query.length > 0 && !target.includes('?')) {
    const search = query
      .map((p) => `${p.name}=${p.value}`)
      .join('&');
    target = `${target}?${search}`;
  }

  lines.push(`${request.method} ${target} HTTP/1.1`);

  for (const header of enabled(request.headers)) {
    lines.push(`${header.name}: ${header.value}`);
  }

  const auth = request.auth;
  if (auth?.type === 'bearer' && auth.bearer) {
    lines.push(`Authorization: Bearer ${auth.bearer}`);
  } else if (auth?.type === 'basic' && auth.basic) {
    lines.push(
      `Authorization: Basic ${toBase64(
        `${auth.basic.username}:${auth.basic.password}`
      )}`
    );
  }

  const cookies = enabled(request.cookies);
  if (cookies.length > 0) {
    lines.push(
      `Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}`
    );
  }

  // The engine adds a Content-Type when the body implies one and no explicit
  // header exists; mirror that here so the preview matches the real request.
  const hasContentType = enabled(request.headers).some(
    (h) => h.name.toLowerCase() === 'content-type'
  );
  let implied = impliedContentType(request);
  if (implied && sent?.boundary) {
    implied = `multipart/form-data; boundary=${sent.boundary}`;
  }
  if (!hasContentType && implied) {
    lines.push(`Content-Type: ${implied}`);
  }
  if (sent) {
    lines.push(`Content-Length: ${sent.totalBytes}`);
  }

  const body = request.body;
  let payload = '';

  if (body) {
    if (body.type === 'json' || body.type === 'xml' || body.type === 'text') {
      payload = body.raw ?? '';
    } else if (body.type === 'graphql') {
      // The wire body is a JSON envelope, not the bare query.
      const variables = stripJsonComments(body.graphqlVariables ?? '').trim();
      let parsed: unknown;
      try {
        parsed = variables ? JSON.parse(variables) : undefined;
      } catch {
        parsed = undefined;
      }
      payload = JSON.stringify({
        query: body.raw ?? '',
        ...(parsed !== undefined ? { variables: parsed } : {}),
      });
    } else if (body.type === 'formencoded') {
      payload = enabled(body.form)
        .map(
          (f) =>
            `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`
        )
        .join('&');
    } else if (body.type === 'formdata') {
      // Show the real multipart framing rather than a shorthand, so the Raw
      // tab matches what actually goes on the wire.
      const boundary = sent?.boundary ?? PREVIEW_BOUNDARY;
      const parts: string[] = [];
      for (const field of enabled(body.form)) {
        parts.push(`--${boundary}`);
        if (field.isFile) {
          const file = baseName(field.value);
          parts.push(
            `Content-Disposition: form-data; name="${field.name}"; filename="${file}"`
          );
          parts.push(`Content-Type: ${mimeFor(file)}`);
          parts.push('');
          const info = sent?.files?.find((f) => f.name === field.name);
          if (info?.preview !== undefined) {
            parts.push(info.preview);
          } else if (info) {
            parts.push(
              `<${info.bytes.toLocaleString()} bytes — ${formatBytes(info.bytes)}. ` +
                `Use "Load full bytes" above to display them.>`
            );
          } else {
            parts.push(`<contents of ${field.value}>`);
          }
        } else {
          parts.push(`Content-Disposition: form-data; name="${field.name}"`);
          parts.push('');
          parts.push(field.value);
        }
      }
      parts.push(`--${boundary}--`);
      payload = parts.join('\n');
    } else if (body.type === 'binary' && body.binaryPath) {
      // The binary body is keyed under an empty field name, matching how the
      // engine reports it and how the Raw tab requests its bytes.
      const info = sent?.files?.find((f) => f.name === '');
      if (info?.preview !== undefined) {
        payload = info.preview;
      } else if (info) {
        payload =
          `<${info.bytes.toLocaleString()} bytes — ${formatBytes(info.bytes)}. ` +
          `Use "Load full bytes" above to display them.>`;
      } else {
        payload = `@${body.binaryPath}`;
      }
    }
  }

  if (payload) {
    lines.push('');
    lines.push(payload);
  }

  return lines.join('\n');
}

function impliedContentType(request: ApiRequest): string | null {
  switch (request.body?.type) {
    case 'json':
    case 'graphql':
      return 'application/json';
    case 'xml':
      return 'application/xml';
    case 'text':
      return 'text/plain';
    case 'formencoded':
      return 'application/x-www-form-urlencoded';
    case 'formdata':
      return `multipart/form-data; boundary=${PREVIEW_BOUNDARY}`;
    case 'binary':
      return request.body.binaryPath ? 'application/octet-stream' : null;
    default:
      return null;
  }
}

/**
 * Parses an HTTP message back into request fields. Returns every problem it
 * finds so nothing is applied from a partially valid edit.
 */
export function fromRawHttp(source: string): RawParseResult {
  const errors: string[] = [];
  const text = source.replace(/\r\n/g, '\n');

  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const payload = blank === -1 ? '' : text.slice(blank + 2);

  const headLines = head.split('\n').filter((l) => l.trim() !== '');
  if (headLines.length === 0) {
    return { ok: false, errors: ['The request line is missing.'] };
  }

  const requestLine = headLines[0].trim();
  const parts = requestLine.split(/\s+/);

  if (parts.length < 2) {
    return {
      ok: false,
      errors: [
        `Line 1: expected "METHOD /path HTTP/1.1", got "${requestLine}".`,
      ],
    };
  }

  const method = parts[0].toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) {
    errors.push(`Line 1: "${parts[0]}" is not a supported method.`);
  }

  const target = parts[1];
  const headers: KeyValue[] = [];
  const cookies: KeyValue[] = [];
  let auth: ApiRequest['auth'] = { type: 'none' };
  let hostHeader = '';

  for (let i = 1; i < headLines.length; i++) {
    const line = headLines[i];
    const sep = line.indexOf(':');

    if (sep <= 0) {
      errors.push(
        `Line ${i + 1}: expected "Name: value", got "${line.trim()}".`
      );
      continue;
    }

    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    const lower = name.toLowerCase();

    if (lower === 'host') {
      hostHeader = value;
      continue;
    }

    if (lower === 'cookie') {
      for (const pair of value.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          cookies.push({
            name: pair.slice(0, eq).trim(),
            value: pair.slice(eq + 1).trim(),
          });
        }
      }
      continue;
    }

    if (lower === 'authorization') {
      if (/^bearer\s+/i.test(value)) {
        auth = { type: 'bearer', bearer: value.replace(/^bearer\s+/i, '') };
        continue;
      }
      const placeholder = /^basic\s+<(.*):(.*)>$/i.exec(value);
      if (placeholder) {
        auth = {
          type: 'basic',
          basic: { username: placeholder[1], password: placeholder[2] },
        };
        continue;
      }

      const encoded = /^basic\s+(\S+)$/i.exec(value);
      if (encoded) {
        const decoded = fromBase64(encoded[1]);
        const colon = decoded === null ? -1 : decoded.indexOf(':');
        if (decoded !== null && colon >= 0) {
          auth = {
            type: 'basic',
            basic: {
              username: decoded.slice(0, colon),
              password: decoded.slice(colon + 1),
            },
          };
          continue;
        }
      }
    }

    headers.push({ name, value });
  }

  // Rebuild the URL and split the query string back into params.
  let url = target;
  const params: ApiRequest['params'] = [];
  const queryAt = target.indexOf('?');

  if (queryAt >= 0) {
    url = target.slice(0, queryAt);
    for (const pair of target.slice(queryAt + 1).split('&')) {
      if (!pair) {
        continue;
      }
      const eq = pair.indexOf('=');
      params.push({
        name: eq < 0 ? pair : pair.slice(0, eq),
        value: eq < 0 ? '' : pair.slice(eq + 1),
        isPath: false,
      });
    }
  }

  if (hostHeader && !/^[a-zA-Z][\w+.-]*:\/\//.test(url) && !url.startsWith('{{')) {
    const scheme = hostHeader.startsWith('localhost') ? 'http' : 'https';
    url = `${scheme}://${hostHeader}${url.startsWith('/') ? url : `/${url}`}`;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const contentType =
    headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';

  return {
    ok: true,
    errors: [],
    request: {
      method,
      url,
      params,
      headers,
      cookies,
      auth,
      body: parseBody(payload, contentType),
    },
  };
}

function parseBody(
  payload: string,
  contentType: string
): ApiRequest['body'] {
  const trimmed = payload.trim();

  if (!trimmed) {
    return { type: 'none', raw: '', form: [] };
  }

  if (trimmed.startsWith('@') && !trimmed.includes('\n')) {
    return { type: 'binary', raw: '', form: [], binaryPath: trimmed.slice(1) };
  }

  const type = contentType.toLowerCase();

  if (type.includes('x-www-form-urlencoded')) {
    return {
      type: 'formencoded',
      raw: '',
      form: trimmed
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf('=');
          return {
            name: decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq)),
            value: eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1)),
          };
        }),
    };
  }

  if (type.includes('multipart/form-data')) {
    return { type: 'formdata', raw: '', form: parseMultipart(trimmed) };
  }

  if (type.includes('xml') || trimmed.startsWith('<')) {
    return { type: 'xml', raw: payload.replace(/^\n+|\n+$/g, ''), form: [] };
  }

  if (type.includes('graphql') || /^\s*(query|mutation|subscription)\b/.test(trimmed)) {
    return { type: 'graphql', raw: payload.replace(/^\n+|\n+$/g, ''), form: [] };
  }

  // A JSON body carrying a `query` field is a GraphQL envelope.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(stripJsonComments(trimmed)) as {
        query?: unknown;
        variables?: unknown;
      };
      if (typeof parsed.query === 'string') {
        return {
          type: 'graphql',
          raw: parsed.query,
          form: [],
          graphqlVariables:
            parsed.variables === undefined
              ? ''
              : JSON.stringify(parsed.variables, null, 2),
        };
      }
    } catch {
      // fall through to the normal JSON handling below
    }
  }

  if (type.includes('json') || isJsonLike(trimmed)) {
    return { type: 'json', raw: payload.replace(/^\n+|\n+$/g, ''), form: [] };
  }

  return { type: 'text', raw: payload.replace(/^\n+|\n+$/g, ''), form: [] };
}

/**
 * Reads either real multipart framing or the `name=value` shorthand, so both
 * a pasted request and a hand-typed one work.
 */
function parseMultipart(payload: string): KeyValue[] {
  const fields: KeyValue[] = [];

  if (!payload.includes('Content-Disposition')) {
    for (const line of payload.split('\n').filter((l) => l.trim())) {
      const eq = line.indexOf('=');
      const name = (eq < 0 ? line : line.slice(0, eq)).trim();
      const value = eq < 0 ? '' : line.slice(eq + 1);
      const isFile = value.startsWith('@');
      fields.push({
        name,
        value: isFile ? value.slice(1) : value,
        ...(isFile ? { isFile: true } : {}),
      });
    }
    return fields;
  }

  const blocks = payload.split(/^--\S+\s*$/m).filter((b) => b.trim());

  for (const block of blocks) {
    const nameMatch = /name="([^"]*)"/.exec(block);
    if (!nameMatch) {
      continue;
    }

    const fileMatch = /filename="([^"]*)"/.exec(block);
    const bodyAt = block.indexOf('\n\n');
    const value = bodyAt < 0 ? '' : block.slice(bodyAt + 2).trim();

    if (fileMatch) {
      const placeholder = /^<contents of (.+)>$/.exec(value);
      fields.push({
        name: nameMatch[1],
        value: placeholder ? placeholder[1] : fileMatch[1],
        isFile: true,
      });
      continue;
    }

    fields.push({ name: nameMatch[1], value });
  }

  return fields;
}

function isJsonLike(text: string): boolean {
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return false;
  }
  try {
    JSON.parse(stripJsonComments(text));
    return true;
  } catch {
    // Still treat brace-wrapped text as JSON so an in-progress edit keeps its
    // tab rather than falling back to plain text.
    return true;
  }
}
