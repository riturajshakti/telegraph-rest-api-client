/**
 * Removes `//` line comments from JSON while leaving string contents intact,
 * so values like "https://example.com" survive untouched.
 *
 * Comments are replaced with nothing but their newlines are preserved, keeping
 * line numbers stable for error reporting.
 */
export function stripJsonComments(source: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < source.length) {
    const char = source[i];

    if (inString) {
      if (char === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      out += char;
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      i++;
      continue;
    }

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end === -1) {
        break;
      }
      i = end;
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

export function hasJsonComments(source: string): boolean {
  return stripJsonComments(source) !== source;
}
