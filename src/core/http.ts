import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { stripJsonComments } from './jsonc';
import { URL } from 'node:url';
import type {
  RedirectHop,
  ApiRequest,
  ApiResponse,
  KeyValue,
  SendResult,
} from './types';

/** Files at or under this size have their bytes inlined in the Raw view. */
export const INLINE_BYTES_LIMIT = 25 * 1024;

export interface SentFileInfo {
  name: string;
  fileName: string;
  bytes: number;
  /** Present when the file is small enough to inline. */
  preview?: string;
}

export interface SentBodyInfo {
  boundary?: string;
  files?: SentFileInfo[];
  totalBytes: number;
}

export interface SendOptions {
  timeout: number;
  followRedirects: boolean;
  responseLimitBytes: number;
  signal?: { aborted: boolean; onAbort?: () => void };
  onUploadProgress?: (sent: number, total: number) => void;
  onBodyPrepared?: (info: SentBodyInfo) => void;
  onStreamStart?: (info: {
    status: number;
    statusText: string;
    headers: KeyValue[];
    contentType: string;
  }) => void;
  onStreamChunk?: (text: string, totalBytes: number) => void;
}

const STREAMING_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/stream+json',
];

export function isStreamingContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return STREAMING_TYPES.some((type) => value.includes(type));
}

const MAX_REDIRECTS = 1000;

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function enabled<T extends KeyValue>(items: T[] | undefined): T[] {
  return (items ?? []).filter((i) => !i.isDisabled && i.name.trim() !== '');
}

function buildUrl(request: ApiRequest): URL {
  const raw = request.url.trim();
  if (!raw) {
    throw new Error('URL is required');
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  for (const param of enabled(request.params)) {
    if (param.isPath) {
      continue;
    }
    if (!url.searchParams.has(param.name)) {
      url.searchParams.append(param.name, param.value);
    }
  }

  return url;
}

function encodeFormUrl(form: KeyValue[]): string {
  return form
    .map(
      (f) =>
        `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`
    )
    .join('&');
}

interface PreparedBody {
  buffer: Buffer | undefined;
  contentType: string | undefined;
  /** Details of what was actually built, for the Raw view. */
  meta?: {
    boundary?: string;
    files?: SentFileInfo[];
  };
}

/** Methods that never carry a request body. */
export function sendsBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function prepareBody(request: ApiRequest): PreparedBody {
  const body = request.body;
  if (!body || body.type === 'none') {
    return { buffer: undefined, contentType: undefined };
  }

  // The Body tab is hidden for these methods, so sending its contents would
  // transmit something the user cannot see.
  if (!sendsBody(request.method)) {
    return { buffer: undefined, contentType: undefined };
  }

  switch (body.type) {
    case 'json':
      return {
        buffer: Buffer.from(stripJsonComments(body.raw ?? ''), 'utf8'),
        contentType: 'application/json',
      };
    case 'graphql': {
      const variables = (body.graphqlVariables ?? '').trim();
      let parsedVariables: unknown = undefined;
      if (variables) {
        try {
          parsedVariables = JSON.parse(stripJsonComments(variables));
        } catch {
          throw new Error('GraphQL variables are not valid JSON');
        }
      }
      const payload = JSON.stringify({
        query: body.raw ?? '',
        ...(parsedVariables !== undefined
          ? { variables: parsedVariables }
          : {}),
      });
      return {
        buffer: Buffer.from(payload, 'utf8'),
        contentType: 'application/json',
      };
    }
    case 'xml':
      return {
        buffer: Buffer.from(body.raw ?? '', 'utf8'),
        contentType: 'application/xml',
      };
    case 'text':
      return {
        buffer: Buffer.from(body.raw ?? '', 'utf8'),
        contentType: 'text/plain',
      };
    case 'formencoded':
      return {
        buffer: Buffer.from(encodeFormUrl(enabled(body.form)), 'utf8'),
        contentType: 'application/x-www-form-urlencoded',
      };
    case 'formdata': {
      const fields = enabled(body.form);
      const boundary = `----TelegraphFormBoundary${randomBytes(12).toString(
        'hex'
      )}`;
      const parts: Buffer[] = [];
      const fileMeta: SentFileInfo[] = [];

      for (const field of fields) {
        parts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));

        if (field.isFile) {
          if (!field.value) {
            continue;
          }
          let contents: Buffer;
          try {
            contents = fs.readFileSync(field.value);
          } catch {
            throw new Error(`Cannot read file: ${field.value}`);
          }
          const fileName = path.basename(field.value);
          parts.push(
            Buffer.from(
              `Content-Disposition: form-data; name="${field.name}"; ` +
                `filename="${fileName}"\r\n` +
                `Content-Type: ${mimeFor(fileName)}\r\n\r\n`,
              'utf8'
            )
          );
          parts.push(contents);
          parts.push(Buffer.from('\r\n', 'utf8'));
          fileMeta.push({
            name: field.name,
            fileName,
            bytes: contents.byteLength,
            ...(contents.byteLength <= INLINE_BYTES_LIMIT
              ? { preview: renderBytes(contents) }
              : {}),
          });
          continue;
        }

        parts.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
              `${field.value}\r\n`,
            'utf8'
          )
        );
      }

      parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

      return {
        buffer: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
        meta: { boundary, files: fileMeta },
      };
    }
    case 'binary': {
      if (!body.binaryPath) {
        return { buffer: undefined, contentType: undefined };
      }
      try {
        const contents = fs.readFileSync(body.binaryPath);
        const fileName = path.basename(body.binaryPath);
        return {
          buffer: contents,
          contentType: 'application/octet-stream',
          meta: {
            files: [
              {
                name: '',
                fileName,
                bytes: contents.byteLength,
                ...(contents.byteLength <= INLINE_BYTES_LIMIT
                  ? { preview: renderBytes(contents) }
                  : {}),
              },
            ],
          },
        };
      } catch {
        throw new Error(`Cannot read file: ${body.binaryPath}`);
      }
    }
    default:
      return {
        buffer: body.raw ? Buffer.from(body.raw, 'utf8') : undefined,
        contentType: undefined,
      };
  }
}

function buildHeaders(
  request: ApiRequest,
  prepared: PreparedBody
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const header of enabled(request.headers)) {
    headers[header.name] = header.value;
  }

  const auth = request.auth;
  if (auth?.type === 'bearer' && auth.bearer) {
    headers['Authorization'] = `Bearer ${auth.bearer}`;
  } else if (auth?.type === 'basic' && auth.basic) {
    const encoded = Buffer.from(
      `${auth.basic.username}:${auth.basic.password}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'content-type'
  );
  if (prepared.contentType && !hasContentType) {
    headers['Content-Type'] = prepared.contentType;
  }

  if (prepared.buffer) {
    headers['Content-Length'] = String(prepared.buffer.byteLength);
  }

  // Cookies live in their own tab; fold them into the Cookie header. An
  // explicit Cookie header still wins so nothing is silently overwritten.
  const cookies = enabled(request.cookies);
  const hasCookieHeader = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'cookie'
  );
  if (cookies.length > 0 && !hasCookieHeader) {
    headers['Cookie'] = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  const hasAccept = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'accept'
  );
  if (!hasAccept) {
    headers['Accept'] = '*/*';
  }

  const hasUserAgent = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'user-agent'
  );
  if (!hasUserAgent) {
    headers['User-Agent'] = DEFAULT_USER_AGENT;
  }

  return headers;
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
  return (
    MIME_TYPES[path.extname(fileName).toLowerCase()] ??
    'application/octet-stream'
  );
}

/** Control bytes that mark a buffer as binary rather than text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F]/;

/**
 * Renders bytes for display: readable text stays as-is, binary becomes a hex
 * dump so it is inspectable without corrupting the view.
 */
export function renderBytes(buffer: Buffer): string {
  const text = buffer.toString('utf8');

  // Treat it as text when it round-trips and holds no control characters.
  const isText =
    Buffer.from(text, 'utf8').equals(buffer) &&
    !CONTROL_CHARS.test(text);

  if (isText) {
    return text;
  }

  const lines: string[] = [];
  for (let offset = 0; offset < buffer.length; offset += 16) {
    const slice = buffer.subarray(offset, offset + 16);
    const hex = [...slice]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const ascii = [...slice]
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}

function flattenHeaders(raw: http.IncomingHttpHeaders): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        out.push({ name, value: v });
      }
    } else if (value !== undefined) {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

interface RawResult {
  status: number;
  statusText: string;
  headers: KeyValue[];
  rawHeaders: http.IncomingHttpHeaders;
  chunks: Buffer[];
  totalBytes: number;
  truncated: boolean;
  firstByteAt: number;
}

function performRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  options: SendOptions
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const startedAt = Date.now();
    let firstByteAt = 0;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        firstByteAt = Date.now() - startedAt;

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;

        const responseType = String(res.headers['content-type'] ?? '');
        const streaming =
          !!options.onStreamChunk && isStreamingContentType(responseType);
        const decoder = streaming ? new StringDecoder('utf8') : null;

        if (streaming) {
          options.onStreamStart?.({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: flattenHeaders(res.headers),
            contentType: responseType,
          });
        }

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          let kept: Buffer | null = null;

          if (totalBytes <= options.responseLimitBytes) {
            chunks.push(chunk);
            kept = chunk;
          } else if (!truncated) {
            truncated = true;
            const room =
              options.responseLimitBytes -
              (totalBytes - chunk.byteLength);
            if (room > 0) {
              const slice = chunk.subarray(0, room);
              chunks.push(slice);
              kept = slice;
            }
          }

          if (decoder && kept) {
            const text = decoder.write(kept);
            if (text) {
              options.onStreamChunk?.(text, totalBytes);
            }
          }
        });

        res.on('end', () => {
          if (decoder) {
            const tail = decoder.end();
            if (tail) {
              options.onStreamChunk?.(tail, totalBytes);
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: flattenHeaders(res.headers),
            rawHeaders: res.headers,
            chunks,
            totalBytes,
            truncated,
            firstByteAt,
          });
        });

        res.on('error', reject);
      }
    );

    if (options.timeout > 0) {
      req.setTimeout(options.timeout, () => {
        req.destroy(new Error(`Request timed out after ${options.timeout}ms`));
      });
    }

    req.on('error', reject);

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error('Request cancelled'));
      } else {
        options.signal.onAbort = () => {
          req.destroy(new Error('Request cancelled'));
        };
      }
    }

    if (body) {
      const total = body.byteLength;
      // Stream large bodies in chunks so upload progress can be reported.
      if (options.onUploadProgress && total > 64 * 1024) {
        const CHUNK = 64 * 1024;
        let sent = 0;

        const writeNext = (): void => {
          while (sent < total) {
            const end = Math.min(sent + CHUNK, total);
            const slice = body.subarray(sent, end);
            const ok = req.write(slice);
            sent = end;
            options.onUploadProgress?.(sent, total);
            if (!ok) {
              req.once('drain', writeNext);
              return;
            }
          }
          req.end();
        };

        writeNext();
        return;
      }

      req.write(body);
    }
    req.end();
  });
}

export async function sendRequest(
  request: ApiRequest,
  options: SendOptions
): Promise<SendResult> {
  const startedAt = Date.now();

  try {
    let url = buildUrl(request);
    let method: string = request.method;
    const prepared = prepareBody(request);
    let bodyBuffer = prepared.buffer;
    options.onBodyPrepared?.({
      ...(prepared.meta ?? {}),
      totalBytes: prepared.buffer?.byteLength ?? 0,
    });
    const headers = buildHeaders(request, prepared);

    const redirects: string[] = [];
    const hops: RedirectHop[] = [];
    let result: RawResult;

    for (let hop = 0; ; hop++) {
      const hopStartedAt = Date.now();
      result = await performRequest(
        url,
        method,
        headers,
        bodyBuffer,
        options
      );

      if (
        !options.followRedirects ||
        !isRedirect(result.status) ||
        !result.rawHeaders.location
      ) {
        break;
      }

      if (hop >= MAX_REDIRECTS) {
        return {
          ok: false,
          error: { message: `Too many redirects (>${MAX_REDIRECTS})` },
        };
      }

      const location = String(result.rawHeaders.location);
      const from = url.toString();
      const previousMethod = method;
      url = new URL(location, url);
      redirects.push(url.toString());

      if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === 'POST')) {
        method = 'GET';
        bodyBuffer = undefined;
        delete headers['Content-Length'];
        delete headers['Content-Type'];
      }

      hops.push({
        status: result.status,
        statusText: result.statusText,
        from,
        to: url.toString(),
        method: previousMethod,
        nextMethod: method,
        durationMs: Date.now() - hopStartedAt,
        setCookie: result.headers
          .filter((h) => h.name.toLowerCase() === 'set-cookie')
          .map((h) => h.value),
      });
    }

    const buffer = Buffer.concat(result.chunks);
    const contentType =
      result.headers.find((h) => h.name.toLowerCase() === 'content-type')
        ?.value ?? '';

    const response: ApiResponse = {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: buffer.toString('utf8'),
      bodyBytes: result.totalBytes,
      truncated: result.truncated,
      timing: {
        total: Date.now() - startedAt,
        firstByte: result.firstByteAt,
      },
      redirects,
      hops,
      contentType,
    };

    return { ok: true, response };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: {
        message: error.message ?? String(err),
        code: error.code,
      },
    };
  }
}
