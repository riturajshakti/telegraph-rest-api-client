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

/** How much of an uploaded file the Raw tab shows before truncating. */
export const UPLOAD_PREVIEW_BYTES = 64 * 1024;

/**
 * Renders the head of an uploaded file for the Raw tab. Large files show a
 * bounded hex dump with a note rather than nothing at all.
 */
function filePreview(contents: Buffer): {
  preview: string;
  previewTruncated: boolean;
  previewBase64: string;
  previewNote: string;
} {
  const head = contents.subarray(0, UPLOAD_PREVIEW_BYTES);
  const dump = renderBytes(head);
  const base64 = head.toString('base64');

  if (contents.byteLength <= UPLOAD_PREVIEW_BYTES) {
    return {
      preview: dump,
      previewTruncated: false,
      previewBase64: base64,
      previewNote: '',
    };
  }

  const note =
    `\n\n<showing the first ${UPLOAD_PREVIEW_BYTES.toLocaleString('en-US')} of ` +
    `${contents.byteLength.toLocaleString('en-US')} bytes — ` +
    `use "Load full bytes" above to display them all>`;

  return {
    preview: dump + note,
    previewTruncated: true,
    previewBase64: base64,
    previewNote: note,
  };
}

export interface SentFileInfo {
  name: string;
  fileName: string;
  bytes: number;
  /** A hex dump of the file, bounded to the first 64 KB. */
  preview?: string;
  /** True when `preview` shows only the head of a larger file. */
  previewTruncated?: boolean;
  /** The same 64 KB head, base64 encoded, for switching hex formats. */
  previewBase64?: string;
  /** Truncation note appended after the dump, when the file was longer. */
  previewNote?: string;
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
  /**
   * How to handle a binary response body.
   *  - 'probe'    stop at the headers and resolve with no body, so the view can
   *               offer a choice without transferring the payload
   *  - 'download' stream straight to `downloadPath`, never buffering
   *  - 'text'     buffer and render a bounded preview
   */
  binaryMode?: 'probe' | 'download' | 'text';
  downloadPath?: string;
  onDownloadProgress?: (received: number, total: number) => void;
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

/** Content types that are never meaningful as text in the response view. */
const BINARY_TYPE_PREFIXES = ['image/', 'video/', 'audio/', 'font/'];

const BINARY_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-bzip',
  'application/x-bzip2',
  'application/wasm',
  'application/x-msdownload',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.oasis.opendocument',
  'application/vnd.android.package-archive',
  'application/x-shockwave-flash',
  'application/epub+zip',
  'application/x-sqlite3',
  'application/protobuf',
  'application/x-protobuf',
];

/**
 * True when a response should be offered as a download rather than rendered.
 * Checked against the declared content type, before any bytes are decoded.
 */
export function isBinaryContentType(contentType: string): boolean {
  const value = contentType.toLowerCase().split(';')[0].trim();
  if (!value) {
    return false;
  }
  if (BINARY_TYPE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    // SVG is XML, so it stays readable.
    return value !== 'image/svg+xml';
  }
  return BINARY_TYPES.some((type) => value.startsWith(type));
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
            ...filePreview(contents),
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
                ...filePreview(contents),
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

  return hexDump(buffer, true);
}

/**
 * Formats bytes as hex rows of 16. With `withOffsets` the row carries a
 * leading offset column and a trailing ASCII gutter; without it, bare hex.
 */
export function hexDump(buffer: Buffer, withOffsets: boolean): string {
  const lines: string[] = [];
  for (let offset = 0; offset < buffer.length; offset += 16) {
    const slice = buffer.subarray(offset, offset + 16);
    const hex = [...slice]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

    if (!withOffsets) {
      lines.push(hex);
      continue;
    }

    const ascii = [...slice]
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  |${ascii}|`
    );
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
  /** Set when the body was deliberately not read, only the headers. */
  probed?: boolean;
  /** How many bytes of the body were read for the preview. */
  headBytes?: number;
  /** Set when the body was streamed to this path instead of buffered. */
  savedTo?: string;
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

        // Announce as soon as the headers land so the view can offer a
        // download for binary payloads instead of waiting for every byte.
        if (streaming || isBinaryContentType(responseType)) {
          options.onStreamStart?.({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: flattenHeaders(res.headers),
            contentType: responseType,
          });
        }

        const isBinary = isBinaryContentType(responseType);
        const mode = options.binaryMode ?? 'text';

        // Read just enough of a binary body to preview it, then stop. The
        // caller decides what to do before the rest crosses the wire.
        if (isBinary && mode === 'probe') {
          const HEAD_BYTES = 64 * 1024;
          const declared = Number(res.headers['content-length'] ?? 0);
          const head: Buffer[] = [];
          let headBytes = 0;
          let settled = false;

          const finish = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            res.destroy();
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: flattenHeaders(res.headers),
              rawHeaders: res.headers,
              chunks: head,
              totalBytes: declared || headBytes,
              truncated: false,
              firstByteAt,
              probed: true,
              headBytes,
            });
          };

          res.on('data', (chunk: Buffer) => {
            if (settled) {
              return;
            }
            const room = HEAD_BYTES - headBytes;
            const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
            head.push(slice);
            headBytes += slice.byteLength;
            if (headBytes >= HEAD_BYTES) {
              finish();
            }
          });

          // A body smaller than the head limit ends before the cap is reached.
          res.on('end', finish);
          res.on('close', finish);
          return;
        }

        // Write to disk as bytes arrive, so file size is bounded by the disk
        // rather than by memory.
        if (isBinary && mode === 'download' && options.downloadPath) {
          const declared = Number(res.headers['content-length'] ?? 0);
          const target = options.downloadPath;
          const out = fs.createWriteStream(target);
          let written = 0;
          let settled = false;

          // A cancel destroys the response mid-pipe, so 'finish' never fires.
          // Close the file, remove the partial download, and reject once.
          const fail = (err: Error): void => {
            if (settled) {
              return;
            }
            settled = true;
            // Remove the partial file only once the stream has released its
            // handle: destroy() is asynchronous, so unlinking immediately
            // races with the final flush and leaves the file behind.
            out.once('close', () => {
              try {
                fs.unlinkSync(target);
              } catch {
                // Already gone, or never created.
              }
              reject(err);
            });
            out.destroy();
          };

          res.on('data', (chunk: Buffer) => {
            written += chunk.byteLength;
            options.onDownloadProgress?.(written, declared);
          });

          res.on('error', fail);
          res.on('aborted', () => fail(new Error('Request cancelled')));
          out.on('error', fail);

          out.on('finish', () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: flattenHeaders(res.headers),
              rawHeaders: res.headers,
              chunks: [],
              totalBytes: written,
              truncated: false,
              firstByteAt,
              savedTo: target,
            });
          });

          res.pipe(out);
          return;
        }

        // A limit of 0 means render everything, however large. Binary payloads
        // ignore the limit outright: they are destined for a download, and a
        // truncated file is a corrupt file.
        const limit =
          options.responseLimitBytes > 0 && !isBinaryContentType(responseType)
            ? options.responseLimitBytes
            : Number.POSITIVE_INFINITY;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          let kept: Buffer | null = null;

          if (totalBytes <= limit) {
            chunks.push(chunk);
            kept = chunk;
          } else if (!truncated) {
            truncated = true;
            const room = limit - (totalBytes - chunk.byteLength);
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

    const binary = isBinaryContentType(contentType);

    // A hex dump runs to roughly five characters per byte, so a large binary
    // payload would cross the webview boundary many times bigger than the file
    // itself. Send a bounded preview; the host keeps the real bytes.
    const PREVIEW_BYTES = 64 * 1024;
    const previewBuffer = buffer.subarray(0, PREVIEW_BYTES);
    // `buffer` may hold only the probe's head, so the real size is the
    // declared total rather than what was actually read.
    const shown = Math.min(buffer.byteLength, PREVIEW_BYTES);
    const previewNote =
      result.totalBytes > shown
        ? `\n\n<showing the first ${shown.toLocaleString('en-US')} of ` +
          `${result.totalBytes.toLocaleString('en-US')} bytes — ` +
          `download for the complete file>`
        : '';
    const binaryBody = renderBytes(previewBuffer) + previewNote;

    // A probe stopped at the headers, so there is no body to render and the
    // size comes from Content-Length rather than from what was read.
    const body = result.savedTo
      ? `<saved to ${result.savedTo}>`
      : binary
      ? binaryBody
      : buffer.toString('utf8');

    const response: ApiResponse = {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      binary,
      // The raw head travels as base64 so the Raw tab can switch between hex
      // formats without another request. Bounded to 64 KB.
      ...(binary
        ? {
            headBase64: previewBuffer.toString('base64'),
            headNote: previewNote,
          }
        : {}),
      ...(result.probed ? { probed: true } : {}),
      ...(result.savedTo ? { savedTo: result.savedTo } : {}),
      body,
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

    return {
      ok: true,
      response,
      ...(result.probed ? { probed: true } : { bytes: buffer }),
      ...(result.savedTo ? { savedTo: result.savedTo } : {}),
    };
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
