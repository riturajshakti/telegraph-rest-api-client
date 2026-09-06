/**
 * Streams a file to the host in chunks, rendered for display, so large files
 * appear progressively instead of blocking until fully read.
 */

import { createReadStream, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parentPort, workerData } from 'node:worker_threads';

/** Control bytes that mark a buffer as binary rather than text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F]/;

/** Emitted to the host per chunk. */
export interface ChunkMessage {
  type: 'chunk';
  text: string;
  bytesRead: number;
  totalBytes: number;
}

interface Input {
  path: string;
  maxBytes: number;
  chunkSize: number;
}

function isTextual(buffer: Buffer): boolean {
  const text = buffer.toString('utf8');
  return (
    Buffer.from(text, 'utf8').equals(buffer) && !CONTROL_CHARS.test(text)
  );
}

function hexDump(buffer: Buffer, startOffset: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 16) {
    const slice = buffer.subarray(i, i + 16);
    const hex = [...slice]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const ascii = [...slice]
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(
      `${(startOffset + i).toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`
    );
  }
  return lines.join('\n');
}

const { path, maxBytes, chunkSize } = workerData as Input;

try {
  const totalBytes = statSync(path).size;
  const limit = Math.min(totalBytes, maxBytes);

  // Decide text vs binary once, from the head of the file, so the rendering
  // stays consistent across chunks.
  let textual: boolean | null = null;

  let bytesRead = 0;
  // StringDecoder buffers partial multi-byte sequences across chunks, which a
  // fixed carry-back cannot do reliably.
  const decoder = new StringDecoder('utf8');

  const stream = createReadStream(path, { end: limit - 1, highWaterMark: chunkSize });

  stream.on('data', (data: string | Buffer) => {
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;

    if (textual === null) {
      textual = isTextual(buffer.subarray(0, Math.min(4096, buffer.length)));
    }

    if (textual) {
      bytesRead += buffer.length;
      parentPort?.postMessage({
        type: 'chunk',
        text: decoder.write(buffer),
        bytesRead,
        totalBytes,
      } satisfies ChunkMessage);
      return;
    }

    const startOffset = bytesRead;
    bytesRead += buffer.length;
    parentPort?.postMessage({
      type: 'chunk',
      text: (startOffset > 0 ? '\n' : '') + hexDump(buffer, startOffset),
      bytesRead,
      totalBytes,
    } satisfies ChunkMessage);
  });

  stream.on('end', () => {
    const tail = textual ? decoder.end() : '';
    if (tail) {
      parentPort?.postMessage({
        type: 'chunk',
        text: tail,
        bytesRead,
        totalBytes,
      } satisfies ChunkMessage);
    }

    const truncated = totalBytes > maxBytes;
    parentPort?.postMessage({
      type: 'done',
      bytesRead,
      totalBytes,
      truncated,
      note: truncated
        ? `\n\n<truncated — showing the first ${maxBytes.toLocaleString()} of ` +
          `${totalBytes.toLocaleString()} bytes>`
        : '',
    });
  });

  stream.on('error', (err) => {
    parentPort?.postMessage({ type: 'error', message: err.message });
  });
} catch (err) {
  parentPort?.postMessage({
    type: 'error',
    message: (err as Error).message,
  });
}
