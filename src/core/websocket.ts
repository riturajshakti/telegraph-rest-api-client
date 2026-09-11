import type { Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { SocketCloseInfo, SocketEntry } from './types';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const TEXT_PREVIEW_CHARS = 256 * 1024;
const BINARY_PREVIEW_BYTES = 1024;
const CLOSE_TIMEOUT_MS = 3000;
const FLUSH_DELAY_MS = 16;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_LABELS: Record<number, string> = {
  1000: 'Normal closure',
  1001: 'Going away',
  1002: 'Protocol error',
  1003: 'Unsupported data',
  1005: 'No status received',
  1006: 'Abnormal closure',
  1007: 'Invalid payload data',
  1008: 'Policy violation',
  1009: 'Message too big',
  1010: 'Mandatory extension',
  1011: 'Internal error',
  1012: 'Service restart',
  1013: 'Try again later',
  1014: 'Bad gateway',
  1015: 'TLS handshake failure',
};

export function closeLabel(code: number): string {
  if (CLOSE_LABELS[code]) {
    return CLOSE_LABELS[code];
  }
  if (code >= 4000 && code <= 4999) {
    return 'Application-defined';
  }
  if (code >= 3000 && code <= 3999) {
    return 'Registered';
  }
  return 'Unknown';
}

function headerKey(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lower);
}

export function headerValue(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const key = headerKey(headers, name);
  return key === undefined ? undefined : headers[key];
}

export function prepareUpgrade(
  url: URL,
  headers: Record<string, string>
): URL {
  const secure = url.protocol === 'wss:';
  const socketScheme = secure || url.protocol === 'ws:';
  const upgrade = headerValue(headers, 'upgrade') ?? '';

  if (!socketScheme && !/websocket/i.test(upgrade)) {
    return url;
  }

  const target = socketScheme
    ? new URL(
        `${secure ? 'https' : 'http'}:${url.href.slice(url.protocol.length)}`
      )
    : url;

  const connection = headerKey(headers, 'connection');
  if (connection === undefined) {
    headers['Connection'] = 'Upgrade';
  } else if (!/\bupgrade\b/i.test(headers[connection])) {
    headers[connection] = `${headers[connection]}, Upgrade`;
  }

  if (headerKey(headers, 'upgrade') === undefined) {
    headers['Upgrade'] = 'websocket';
  }
  if (headerKey(headers, 'sec-websocket-version') === undefined) {
    headers['Sec-WebSocket-Version'] = '13';
  }
  if (headerKey(headers, 'sec-websocket-key') === undefined) {
    headers['Sec-WebSocket-Key'] = randomBytes(16).toString('base64');
  }

  const extensions = headerKey(headers, 'sec-websocket-extensions');
  if (extensions !== undefined) {
    delete headers[extensions];
  }

  return target;
}

export function acceptFor(key: string): string {
  return createHash('sha1')
    .update(key + HANDSHAKE_GUID)
    .digest('base64');
}

export function socketUrl(url: URL): string {
  return url.href.replace(/^http/i, 'ws');
}

export function engineIoVersion(url: URL): number | undefined {
  const version = Number(url.searchParams.get('EIO'));
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);

  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  const mask = randomBytes(4);
  mask.copy(header, 2 + lengthBytes);

  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }

  return Buffer.concat([header, masked]);
}

export interface Frame {
  fin: boolean;
  rsv1: boolean;
  opcode: number;
  payload: Buffer;
}

export class FrameParser {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): Frame[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }

    const frames: Frame[] = [];
    for (let frame = this.next(); frame; frame = this.next()) {
      frames.push(frame);
    }
    return frames;
  }

  private next(): Frame | null {
    if (this.buffered < 2) {
      return null;
    }

    const head = this.peek(Math.min(this.buffered, 14));
    const masked = (head[1] & 0x80) !== 0;
    let length = head[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (head.byteLength < 4) {
        return null;
      }
      length = head.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (head.byteLength < 10) {
        return null;
      }
      const declared = head.readBigUInt64BE(2);
      if (declared > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error('Frame exceeds 64 MB');
      }
      length = Number(declared);
      offset = 10;
    }

    const maskBytes = masked ? 4 : 0;
    const total = offset + maskBytes + length;
    if (this.buffered < total) {
      return null;
    }

    const bytes = this.take(total);
    let payload = bytes.subarray(offset + maskBytes);

    if (masked) {
      const key = bytes.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.byteLength; i++) {
        payload[i] ^= key[i & 3];
      }
    }

    return {
      fin: (bytes[0] & 0x80) !== 0,
      rsv1: (bytes[0] & 0x40) !== 0,
      opcode: bytes[0] & 0x0f,
      payload,
    };
  }

  private peek(count: number): Buffer {
    const first = this.chunks[0];
    return first.byteLength >= count
      ? first.subarray(0, count)
      : Buffer.concat(this.chunks, count);
  }

  private take(count: number): Buffer {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;

    while (filled < count) {
      const chunk = this.chunks[0];
      const need = count - filled;
      if (chunk.byteLength <= need) {
        chunk.copy(out, filled);
        filled += chunk.byteLength;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled += need;
      }
    }

    this.buffered -= count;
    return out;
  }
}

function eventName(data: string): string {
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === 'string'
      ? parsed[0]
      : '';
  } catch {
    return '';
  }
}

function describeSocketIo(packet: string): string {
  const type = packet[0];
  let rest = packet.slice(1);
  let namespace = '/';

  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',');
    namespace = comma === -1 ? rest : rest.slice(0, comma);
    rest = comma === -1 ? '' : rest.slice(comma + 1);
  }

  const where = namespace === '/' ? '' : ` on ${namespace}`;
  const ackId = /^\d+/.exec(rest)?.[0] ?? '';
  const data = rest.slice(ackId.length);

  switch (type) {
    case '0':
      return `Socket.IO connect${where}`;
    case '1':
      return `Socket.IO disconnect${where}`;
    case '2': {
      const name = eventName(data);
      return (
        `Socket.IO event${name ? ` "${name}"` : ''}${where}` +
        (ackId ? ` · ack id ${ackId}` : '')
      );
    }
    case '3':
      return `Socket.IO ack${ackId ? ` id ${ackId}` : ''}${where}`;
    case '4':
      return `Socket.IO connect error${where}`;
    case '5':
      return 'Socket.IO binary event';
    case '6':
      return 'Socket.IO binary ack';
    default:
      return 'Socket.IO packet';
  }
}

export function describeEngineIo(
  text: string
): { note: string; heartbeat: boolean } | null {
  switch (text[0]) {
    case '0':
      return { note: 'Engine.IO open', heartbeat: false };
    case '1':
      return { note: 'Engine.IO close', heartbeat: false };
    case '2':
      return { note: 'Engine.IO ping', heartbeat: true };
    case '3':
      return { note: 'Engine.IO pong', heartbeat: true };
    case '4':
      return { note: describeSocketIo(text.slice(1)), heartbeat: false };
    case '6':
      return { note: 'Engine.IO noop', heartbeat: false };
    default:
      return null;
  }
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.byteLength);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

function closeText(code: number, reason: string): string {
  return reason ? `${code} ${reason}` : `${code}`;
}

function textFields(
  text: string,
  bytes: number
): Pick<SocketEntry, 'kind' | 'text' | 'bytes' | 'truncated'> {
  return text.length > TEXT_PREVIEW_CHARS
    ? { kind: 'text', text: text.slice(0, TEXT_PREVIEW_CHARS), bytes, truncated: true }
    : { kind: 'text', text, bytes };
}

function binaryFields(
  payload: Buffer
): Pick<SocketEntry, 'kind' | 'text' | 'bytes' | 'base64' | 'truncated'> {
  return {
    kind: 'binary',
    text: '',
    bytes: payload.byteLength,
    base64: payload.subarray(0, BINARY_PREVIEW_BYTES).toString('base64'),
    ...(payload.byteLength > BINARY_PREVIEW_BYTES ? { truncated: true } : {}),
  };
}

export interface SessionHandlers {
  onEntries: (entries: SocketEntry[]) => void;
  onClose: (info: SocketCloseInfo) => void;
}

type SessionState = 'idle' | 'open' | 'closing' | 'closed';

export class WebSocketSession {
  private readonly parser = new FrameParser();
  private state: SessionState = 'idle';
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private fragmentCompressed = false;
  private initiator: SocketCloseInfo['by'] | null = null;
  private sentClose: { code: number; reason: string } | null = null;
  private receivedClose: { code: number; reason: string } | null = null;
  private failure: string | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: SocketEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly socket: Socket,
    private readonly head: Buffer,
    private readonly engineIo: number | undefined,
    private readonly handlers: SessionHandlers
  ) {
    socket.on('error', (err: Error) => {
      this.failure = err.message;
    });
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  start(): void {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'open';
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
    this.socket.on('close', () => this.finish());

    if (this.head.byteLength > 0) {
      this.receive(this.head);
    }
    if (this.socket.destroyed) {
      this.finish();
    }
  }

  sendText(text: string, automatic?: string): boolean {
    if (this.state !== 'open') {
      return false;
    }

    const payload = Buffer.from(text, 'utf8');
    this.writeFrame(OP_TEXT, payload);

    const described = this.engineIo ? describeEngineIo(text) : null;
    const note = [described?.note, automatic].filter(Boolean).join(' · ');

    this.record({
      direction: 'out',
      ...textFields(text, payload.byteLength),
      ...(note ? { note } : {}),
      ...(described?.heartbeat ? { heartbeat: true } : {}),
      ...(automatic ? { automatic: true } : {}),
    });
    return true;
  }

  close(code = 1000, reason = ''): void {
    if (this.state === 'idle') {
      this.state = 'closed';
      this.socket.destroy();
      return;
    }
    if (this.state !== 'open') {
      return;
    }

    this.state = 'closing';
    this.initiator = 'client';
    this.sentClose = { code, reason };

    const payload = closePayload(code, reason);
    this.writeFrame(OP_CLOSE, payload);
    this.record({
      direction: 'out',
      kind: 'close',
      text: closeText(code, reason),
      bytes: payload.byteLength,
      note: closeLabel(code),
    });
    this.armCloseTimer();
  }

  private receive(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.fail(1009, (err as Error).message);
      return;
    }

    for (const frame of frames) {
      if (this.state === 'closed') {
        return;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmentOpcode !== 0) {
          this.fail(1002, 'A new message started before the previous one ended');
          return;
        }
        if (frame.fin) {
          this.handleMessage(frame.opcode, frame.payload, frame.rsv1);
          return;
        }
        this.fragmentOpcode = frame.opcode;
        this.fragmentCompressed = frame.rsv1;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.byteLength;
        return;

      case OP_CONTINUATION: {
        if (this.fragmentOpcode === 0) {
          this.fail(1002, 'Continuation frame with no message to continue');
          return;
        }
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.byteLength;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.fail(1009, 'Message exceeds 64 MB');
          return;
        }
        if (!frame.fin) {
          return;
        }
        const opcode = this.fragmentOpcode;
        const compressed = this.fragmentCompressed;
        const payload = Buffer.concat(this.fragments);
        this.fragmentOpcode = 0;
        this.fragmentCompressed = false;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.handleMessage(opcode, payload, compressed);
        return;
      }

      case OP_PING:
        this.writeFrame(OP_PONG, frame.payload);
        this.record({
          direction: 'in',
          kind: 'ping',
          text: frame.payload.toString('utf8'),
          bytes: frame.payload.byteLength,
          note: 'Answered with a pong automatically',
        });
        return;

      case OP_PONG:
        this.record({
          direction: 'in',
          kind: 'pong',
          text: frame.payload.toString('utf8'),
          bytes: frame.payload.byteLength,
        });
        return;

      case OP_CLOSE:
        this.handleClose(frame.payload);
        return;

      default:
        this.fail(1002, `Unknown opcode 0x${frame.opcode.toString(16)}`);
    }
  }

  private handleMessage(
    opcode: number,
    payload: Buffer,
    compressed: boolean
  ): void {
    if (compressed) {
      this.record({
        direction: 'in',
        ...binaryFields(payload),
        note: 'Compressed with permessage-deflate, which was not negotiated',
      });
      return;
    }

    if (opcode === OP_BINARY) {
      this.record({ direction: 'in', ...binaryFields(payload) });
      return;
    }

    const text = payload.toString('utf8');
    const described = this.engineIo ? describeEngineIo(text) : null;
    this.record({
      direction: 'in',
      ...textFields(text, payload.byteLength),
      ...(described ? { note: described.note } : {}),
      ...(described?.heartbeat ? { heartbeat: true } : {}),
    });

    if (this.engineIo) {
      this.handleEngineIo(text);
    }
  }

  private handleEngineIo(text: string): void {
    if (text[0] === '2') {
      this.sendText(`3${text.slice(1)}`, 'sent automatically');
      return;
    }

    if (text[0] !== '0') {
      return;
    }

    if ((this.engineIo ?? 0) >= 4) {
      this.sendText('40', 'sent automatically to join the default namespace');
      return;
    }

    let interval = 25000;
    try {
      const open = JSON.parse(text.slice(1)) as { pingInterval?: unknown };
      if (typeof open.pingInterval === 'number' && open.pingInterval > 0) {
        interval = open.pingInterval;
      }
    } catch {
      interval = 25000;
    }
    this.heartbeatTimer = setInterval(
      () => this.sendText('2', 'sent automatically'),
      interval
    );
  }

  private handleClose(payload: Buffer): void {
    const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason =
      payload.byteLength > 2 ? payload.subarray(2).toString('utf8') : '';
    this.receivedClose = { code, reason };

    this.record({
      direction: 'in',
      kind: 'close',
      text: closeText(code, reason),
      bytes: payload.byteLength,
      note: closeLabel(code),
    });

    if (this.state === 'open') {
      this.state = 'closing';
      this.initiator = 'server';
      const echo = payload.byteLength >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0);
      this.writeFrame(OP_CLOSE, echo);
      this.record({
        direction: 'out',
        kind: 'close',
        text: `${code}`,
        bytes: echo.byteLength,
        note: 'Close handshake answered automatically',
        automatic: true,
      });
    }

    this.socket.end();
    this.armCloseTimer();
  }

  private fail(code: number, message: string): void {
    if (this.state === 'closed') {
      return;
    }
    this.failure = message;

    if (this.state === 'open') {
      this.state = 'closing';
      this.initiator = 'error';
      this.sentClose = { code, reason: message };
      this.writeFrame(OP_CLOSE, closePayload(code, message));
    }

    this.socket.end();
    this.armCloseTimer();
  }

  private finish(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';

    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    let info: SocketCloseInfo;
    if (this.initiator === 'server' && this.receivedClose) {
      info = {
        ...this.receivedClose,
        label: closeLabel(this.receivedClose.code),
        by: 'server',
      };
    } else if (
      (this.initiator === 'client' || this.initiator === 'error') &&
      this.sentClose
    ) {
      info = {
        ...this.sentClose,
        label: closeLabel(this.sentClose.code),
        by: this.initiator,
      };
    } else {
      info = {
        code: 1006,
        reason: this.failure ?? 'The connection dropped without a close frame',
        label: closeLabel(1006),
        by: 'network',
      };
    }

    this.flush();
    this.handlers.onClose(info);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(encodeFrame(opcode, payload));
    }
  }

  private armCloseTimer(): void {
    if (this.closeTimer) {
      return;
    }
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  private record(entry: Omit<SocketEntry, 'id' | 'at'>): void {
    this.queue.push({ id: this.nextId++, at: Date.now(), ...entry });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) {
      return;
    }
    const entries = this.queue;
    this.queue = [];
    this.handlers.onEntries(entries);
  }
}
