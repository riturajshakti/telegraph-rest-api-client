/**
 * Pretty-printers for request bodies, shared by the editor's format buttons and
 * by cURL import so a pasted request arrives readable.
 */

import { stripJsonComments } from './jsonc';

export function formatJson(source: string): string | null {
  try {
    return JSON.stringify(
      JSON.parse(stripJsonComments(source)) as unknown,
      null,
      2
    );
  } catch {
    return null;
  }
}

export function formatXml(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith('<')) {
    return null;
  }

  // Split so every tag and every run of text sits on its own line.
  const tokens = trimmed
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const out: string[] = [];
  let depth = 0;

  for (const token of tokens) {
    const isClosing = /^<\//.test(token);
    const isDeclaration = /^<[?!]/.test(token);
    const isSelfClosing = /\/>$/.test(token);
    // A tag that opens and closes on the same line, e.g. <n>Raj</n>
    const isComplete = /^<([\w:.-]+)[^>]*>.*<\/\1>$/.test(token);

    if (isClosing) {
      depth = Math.max(0, depth - 1);
    }

    out.push('  '.repeat(depth) + token);

    const opensBlock =
      !isClosing &&
      !isDeclaration &&
      !isSelfClosing &&
      !isComplete &&
      /^<[\w:.-]/.test(token);

    if (opensBlock) {
      depth++;
    }
  }

  return out.join('\n');
}

export function formatGraphql(source: string): string | null {
  const text = source.trim();
  if (!text) {
    return null;
  }

  // Tokenise so braces break lines but argument lists, strings and comments
  // stay intact on the line they belong to.
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      tokens.push(text.slice(i, stop).trimEnd());
      i = stop;
      continue;
    }

    if (char === '{' || char === '}') {
      tokens.push(char);
      i++;
      continue;
    }

    // A run of everything up to the next brace, collapsing internal
    // whitespace so wrapped arguments rejoin onto one line.
    let j = i;
    let depth = 0;
    let quote: string | null = null;

    while (j < text.length) {
      const c = text[j];

      if (quote) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          quote = null;
        }
        j++;
        continue;
      }

      if (c === '"') {
        quote = '"';
        j++;
        continue;
      }
      if (c === '(' || c === '[') {
        depth++;
        j++;
        continue;
      }
      if (c === ')' || c === ']') {
        depth = Math.max(0, depth - 1);
        j++;
        continue;
      }
      if (depth === 0 && (c === '{' || c === '}' || c === '#')) {
        break;
      }
      j++;
    }

    const run = text
      .slice(i, j)
      .replace(/\s+/g, ' ')
      .replace(/\s*([(,:])\s*/g, (_all, p: string) =>
        p === ',' ? ', ' : p === ':' ? ': ' : '('
      )
      .replace(/\s*\)/g, ')')
      .trim();

    if (run) {
      tokens.push(run);
    }
    i = j;
  }

  const out: string[] = [];
  let indent = 0;

  for (const token of tokens) {
    if (token === '{') {
      if (out.length > 0) {
        out[out.length - 1] += ' {';
      } else {
        out.push('{');
      }
      indent++;
      continue;
    }

    if (token === '}') {
      indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + '}');
      continue;
    }

    // A run of plain leaf fields belongs one per line, GraphQL style — but an
    // operation header like `query Q` is a single line, not two fields.
    const isOperationHeader =
      /^(query|mutation|subscription|fragment)\b/.test(token);

    if (
      !isOperationHeader &&
      /^[A-Za-z_][\w]*(\s+[A-Za-z_][\w]*)+$/.test(token)
    ) {
      for (const field of token.split(' ')) {
        out.push('  '.repeat(indent) + field);
      }
      continue;
    }

    out.push('  '.repeat(indent) + token);
  }

  return out.join('\n');
}
