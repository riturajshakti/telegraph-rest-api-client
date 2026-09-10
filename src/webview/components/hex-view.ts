export interface HexOptions {
  hex: boolean;
  offsets: boolean;
}

const PRINTABLE_MIN = 32;
const PRINTABLE_MAX = 126;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Formats bytes as hex rows of 16. With `offsets` each row carries a leading
 * offset column and a trailing ASCII gutter; without it, bare hex.
 */
export function hexDump(bytes: Uint8Array, offsets: boolean): string {
  const lines: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

    if (!offsets) {
      lines.push(hex);
      continue;
    }

    const ascii = Array.from(slice)
      .map((b) =>
        b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : '.'
      )
      .join('');
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  |${ascii}|`
    );
  }

  return lines.join('\n');
}

/**
 * Renders a base64 head for the Raw tabs. Hex off decodes the bytes as text,
 * which is what the wire actually carried for anything textual.
 */
export function renderHead(
  base64: string,
  note: string,
  options: HexOptions
): string {
  const bytes = decodeBase64(base64);

  if (!options.hex) {
    return new TextDecoder('utf-8').decode(bytes) + note;
  }

  return hexDump(bytes, options.offsets) + note;
}
