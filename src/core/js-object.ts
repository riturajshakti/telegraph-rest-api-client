/**
 * Converts a JavaScript object literal into strict JSON.
 *
 * Handles unquoted keys, single-quoted strings, trailing commas, and comments —
 * the shapes you get when pasting from browser devtools or source code.
 * Returns null when the input is already valid JSON or cannot be converted.
 */
export function jsObjectToJson(source: string): string | null {
  const text = source.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) {
    return null;
  }

  try {
    JSON.parse(text);
    return null;
  } catch {
    // not already JSON, keep going
  }

  let converted: string;
  try {
    converted = transform(text);
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(converted) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function transform(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const { text, next } = readString(source, i, char);
      out += text;
      i = next;
      continue;
    }

    if (char === ',') {
      let k = i + 1;
      while (k < source.length && /\s/.test(source[k])) {
        k++;
      }
      if (source[k] === '}' || source[k] === ']') {
        i++;
        continue;
      }
      out += char;
      i++;
      continue;
    }

    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    if (identifier) {
      const word = identifier[0];
      let k = i + word.length;
      while (k < source.length && /\s/.test(source[k])) {
        k++;
      }

      if (source[k] === ':' && !isValueKeyword(word)) {
        out += JSON.stringify(word);
        i += word.length;
        continue;
      }

      out += word === 'undefined' ? 'null' : word;
      i += word.length;
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

function isValueKeyword(word: string): boolean {
  return word === 'true' || word === 'false' || word === 'null';
}

function readString(
  source: string,
  start: number,
  quote: string
): { text: string; next: number } {
  let i = start + 1;
  let value = '';

  while (i < source.length) {
    const char = source[i];

    if (char === '\\') {
      const escaped = source[i + 1];
      if (escaped === quote && quote !== '"') {
        value += escaped;
      } else if (escaped === '\n') {
        // line continuation inside a template literal
      } else {
        value += char + escaped;
      }
      i += 2;
      continue;
    }

    if (char === quote) {
      i++;
      break;
    }

    if (char === '\n' && quote === '`') {
      value += '\\n';
      i++;
      continue;
    }

    if (char === '"' && quote !== '"') {
      value += '\\"';
      i++;
      continue;
    }

    value += char;
    i++;
  }

  return { text: `"${value}"`, next: i };
}
