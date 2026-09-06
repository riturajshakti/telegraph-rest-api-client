import type { Language } from './highlight';

export interface FoldRegion {
  /** Zero-based line where the foldable block opens. */
  start: number;
  /** Zero-based line where it closes (inclusive). */
  end: number;
}

const OPENERS: Record<string, string> = { '{': '}', '[': ']' };
const CLOSERS = new Set(['}', ']']);

/**
 * Finds foldable regions by tracking bracket depth, ignoring anything inside
 * strings or comments so a brace in a value never opens a phantom region.
 */
function bracketRegions(source: string): FoldRegion[] {
  const lines = source.split('\n');
  const stack: number[] = [];
  const regions: FoldRegion[] = [];

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let inString: string | null = null;

    for (let c = 0; c < line.length; c++) {
      const char = line[c];

      if (inBlockComment) {
        if (char === '*' && line[c + 1] === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }

      if (inString) {
        if (char === '\\') {
          c++;
        } else if (char === inString) {
          inString = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }

      if (char === '/' && line[c + 1] === '/') {
        break;
      }
      if (char === '#') {
        break;
      }
      if (char === '/' && line[c + 1] === '*') {
        inBlockComment = true;
        c++;
        continue;
      }

      if (OPENERS[char]) {
        stack.push(i);
        continue;
      }

      if (CLOSERS.has(char)) {
        const start = stack.pop();
        // Only worth folding when it actually spans lines.
        if (start !== undefined && i > start) {
          regions.push({ start, end: i });
        }
      }
    }
  }

  return regions;
}

/** Finds foldable regions from XML/HTML element nesting. */
function tagRegions(source: string): FoldRegion[] {
  const lines = source.split('\n');
  const stack: { name: string; line: number }[] = [];
  const regions: FoldRegion[] = [];

  const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tags = line.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g);

    for (const tag of tags) {
      const [, closing, name, attrs, selfClosing] = tag;

      if (closing) {
        // Unwind to the matching opener, tolerating unclosed tags.
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].name === name) {
            const opened = stack[s].line;
            stack.length = s;
            if (i > opened) {
              regions.push({ start: opened, end: i });
            }
            break;
          }
        }
        continue;
      }

      if (selfClosing || VOID_ELEMENTS.has(name.toLowerCase())) {
        continue;
      }

      // A tag that opens and closes on the same line is not foldable.
      const sameLineClose = new RegExp(`</${name}\\s*>`).test(
        line.slice((tag.index ?? 0) + tag[0].length)
      );
      if (sameLineClose) {
        continue;
      }

      void attrs;
      stack.push({ name, line: i });
    }
  }

  return regions;
}

export function findFoldRegions(
  source: string,
  language: Language
): FoldRegion[] {
  if (!source.trim()) {
    return [];
  }

  const regions =
    language === 'xml' || language === 'html'
      ? tagRegions(source)
      : bracketRegions(source);

  // Outermost first, so nested arrows render in a sensible order.
  return regions.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** True when this language supports folding at all. */
export function isFoldable(language: Language): boolean {
  return (
    language === 'json' ||
    language === 'xml' ||
    language === 'html' ||
    language === 'graphql'
  );
}
