export type Language =
  | 'json'
  | 'xml'
  | 'html'
  | 'css'
  | 'javascript'
  | 'graphql'
  | 'text';

interface Token {
  text: string;
  cls: string;
  title?: string;
}

const VAR = /\{\{\s*[^{}]*?\s*\}\}/;

export interface VarInfo {
  value: string;
  source: string;
}

let knownVars: Record<string, VarInfo> = {};

export function setKnownVariables(vars: Record<string, VarInfo>): void {
  knownVars = vars;
}

/**
 * Describes the {{variable}} at a character offset, if any. Used to build a
 * tooltip on the editable element, since the highlight layer sits underneath
 * the input and never receives the mouse itself.
 */
export function describeVariableAt(
  source: string,
  offset: number
): string | null {
  const pattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let match = pattern.exec(source);

  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return describeVariable(match[1].trim());
    }
    match = pattern.exec(source);
  }

  return null;
}

export function variableNameAt(
  source: string,
  offset: number
): string | null {
  const pattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let match = pattern.exec(source);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return match[1].trim();
    }
    match = pattern.exec(source);
  }
  return null;
}

export function describeVariable(name: string): string {
  const info = knownVars[name];
  if (!info) {
    return `${name} is not defined in the current environment`;
  }
  const preview =
    info.value.length > 200 ? `${info.value.slice(0, 200)}…` : info.value;
  return info.source
    ? `${name} = ${preview}\n(${info.source})`
    : `${name} = ${preview}`;
}

function varToken(raw: string): Token {
  const name = raw.replace(/^\{\{\s*|\s*\}\}$/g, '');
  return {
    text: raw,
    cls: knownVars[name] ? 'tk-var' : 'tk-var-missing',
    title: describeVariable(name),
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emit(tokens: Token[], text: string, cls: string): void {
  if (text) {
    tokens.push({ text, cls });
  }
}

function emitVar(tokens: Token[], raw: string): void {
  tokens.push(varToken(raw));
}

/**
 * Splits a already-classified run so that {{variables}} inside it
 * get their own class while keeping the surrounding class intact.
 */
function withVars(tokens: Token[], text: string, cls: string): void {
  let rest = text;
  let match = VAR.exec(rest);

  while (match) {
    emit(tokens, rest.slice(0, match.index), cls);
    emitVar(tokens, match[0]);
    rest = rest.slice(match.index + match[0].length);
    match = VAR.exec(rest);
  }

  emit(tokens, rest, cls);
}

function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    if (char === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      const text = source.slice(i, j);

      let k = j;
      while (k < source.length && /\s/.test(source[k])) {
        k++;
      }
      const isKey = source[k] === ':';
      withVars(tokens, text, isKey ? 'tk-key' : 'tk-string');
      i = j;
      continue;
    }

    const rest = source.slice(i);

    const literal = /^(true|false|null)\b/.exec(rest);
    if (literal) {
      emit(tokens, literal[0], 'tk-literal');
      i += literal[0].length;
      continue;
    }

    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      emit(tokens, number[0], 'tk-number');
      i += number[0].length;
      continue;
    }

    const variable = /^\{\{\s*[^{}]*?\s*\}\}/.exec(rest);
    if (variable) {
      emitVar(tokens, variable[0]);
      i += variable[0].length;
      continue;
    }

    if ('{}[],:'.includes(char)) {
      emit(tokens, char, 'tk-punct');
      i++;
      continue;
    }

    emit(tokens, char, '');
    i++;
  }

  return tokens;
}

function tokenizeXml(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      const stop = end === -1 ? source.length : end + 3;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    if (source[i] === '<') {
      const end = source.indexOf('>', i);
      const stop = end === -1 ? source.length : end + 1;
      const tag = source.slice(i, stop);

      const name = /^<\/?[\w:.-]+/.exec(tag);
      if (name) {
        emit(tokens, name[0], 'tk-tag');
        let rest = tag.slice(name[0].length);

        const attr = /([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
        let last = 0;
        let m = attr.exec(rest);
        while (m) {
          emit(tokens, rest.slice(last, m.index), 'tk-tag');
          emit(tokens, m[1], 'tk-attr');
          emit(tokens, m[2], 'tk-punct');
          withVars(tokens, m[3], 'tk-string');
          last = m.index + m[0].length;
          m = attr.exec(rest);
        }
        rest = rest.slice(last);
        emit(tokens, rest, 'tk-tag');
      } else {
        emit(tokens, tag, 'tk-tag');
      }

      i = stop;
      continue;
    }

    const next = source.indexOf('<', i);
    const stop = next === -1 ? source.length : next;
    withVars(tokens, source.slice(i, stop), '');
    i = stop;
  }

  return tokens;
}

const GQL_KEYWORDS =
  /^(query|mutation|subscription|fragment|on|type|input|enum|interface|union|scalar|schema|extend|implements|directive|true|false|null)\b/;

function tokenizeGraphql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const rest = source.slice(i);

    if (char === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    if (char === '"') {
      const block = source.startsWith('"""', i);
      if (block) {
        const end = source.indexOf('"""', i + 3);
        const stop = end === -1 ? source.length : end + 3;
        withVars(tokens, source.slice(i, stop), 'tk-string');
        i = stop;
        continue;
      }
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      withVars(tokens, source.slice(i, j), 'tk-string');
      i = j;
      continue;
    }

    const variable = /^\{\{\s*[^{}]*?\s*\}\}/.exec(rest);
    if (variable) {
      emitVar(tokens, variable[0]);
      i += variable[0].length;
      continue;
    }

    if (char === '$') {
      const name = /^\$[\w]+/.exec(rest);
      if (name) {
        emit(tokens, name[0], 'tk-gqlvar');
        i += name[0].length;
        continue;
      }
    }

    const keyword = GQL_KEYWORDS.exec(rest);
    if (keyword) {
      emit(tokens, keyword[0], 'tk-keyword');
      i += keyword[0].length;
      continue;
    }

    const number = /^-?\d+(\.\d+)?/.exec(rest);
    if (number) {
      emit(tokens, number[0], 'tk-number');
      i += number[0].length;
      continue;
    }

    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (name) {
      let k = i + name[0].length;
      while (k < source.length && /[ \t]/.test(source[k])) {
        k++;
      }
      emit(tokens, name[0], source[k] === ':' ? 'tk-key' : 'tk-field');
      i += name[0].length;
      continue;
    }

    if ('{}()[]:,!=@|&'.includes(char)) {
      emit(tokens, char, 'tk-punct');
      i++;
      continue;
    }

    emit(tokens, char, '');
    i++;
  }

  return tokens;
}

const JS_KEYWORDS =
  /^(const|let|var|function|return|if|else|for|while|new|class|extends|import|export|from|async|await|try|catch|finally|throw|typeof|instanceof|this|null|undefined|true|false)\b/;

function tokenizeJs(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const rest = source.slice(i);

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === char) {
          j++;
          break;
        }
        j++;
      }
      withVars(tokens, source.slice(i, j), 'tk-string');
      i = j;
      continue;
    }

    const keyword = JS_KEYWORDS.exec(rest);
    if (keyword) {
      emit(tokens, keyword[0], 'tk-keyword');
      i += keyword[0].length;
      continue;
    }

    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      emit(tokens, number[0], 'tk-number');
      i += number[0].length;
      continue;
    }

    const name = /^[_$A-Za-z][\w$]*/.exec(rest);
    if (name) {
      let k = i + name[0].length;
      while (k < source.length && /[ \t]/.test(source[k])) {
        k++;
      }
      emit(tokens, name[0], source[k] === '(' ? 'tk-func' : '');
      i += name[0].length;
      continue;
    }

    if ('{}()[];,.:'.includes(char)) {
      emit(tokens, char, 'tk-punct');
      i++;
      continue;
    }

    emit(tokens, char, '');
    i++;
  }

  return tokens;
}

function tokenizeCss(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    const block = source.indexOf('{', i);
    if (block === -1) {
      emit(tokens, source.slice(i), 'tk-tag');
      break;
    }

    emit(tokens, source.slice(i, block), 'tk-tag');
    emit(tokens, '{', 'tk-punct');
    i = block + 1;

    const close = source.indexOf('}', i);
    const stop = close === -1 ? source.length : close;
    const body = source.slice(i, stop);

    const decl = /([\w-]+)(\s*:\s*)([^;]*)(;?)/g;
    let last = 0;
    let m = decl.exec(body);
    while (m) {
      emit(tokens, body.slice(last, m.index), '');
      emit(tokens, m[1], 'tk-attr');
      emit(tokens, m[2], 'tk-punct');
      emit(tokens, m[3], 'tk-string');
      emit(tokens, m[4], 'tk-punct');
      last = m.index + m[0].length;
      m = decl.exec(body);
    }
    emit(tokens, body.slice(last), '');

    if (close !== -1) {
      emit(tokens, '}', 'tk-punct');
      i = close + 1;
    } else {
      i = stop;
    }
  }

  return tokens;
}

function tokenizeHtml(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      const stop = end === -1 ? source.length : end + 3;
      emit(tokens, source.slice(i, stop), 'tk-comment');
      i = stop;
      continue;
    }

    const embedded = /^<(script|style)\b/i.exec(source.slice(i));
    if (embedded) {
      const tagEnd = source.indexOf('>', i);
      if (tagEnd !== -1) {
        for (const token of tokenizeXml(source.slice(i, tagEnd + 1))) {
          tokens.push(token);
        }
        const closeTag = `</${embedded[1]}`;
        const closeAt = source.toLowerCase().indexOf(closeTag, tagEnd);
        const stop = closeAt === -1 ? source.length : closeAt;
        const inner = source.slice(tagEnd + 1, stop);
        const innerTokens =
          embedded[1].toLowerCase() === 'script'
            ? tokenizeJs(inner)
            : tokenizeCss(inner);
        for (const token of innerTokens) {
          tokens.push(token);
        }
        i = stop;
        continue;
      }
    }

    const next = source.indexOf('<', i + 1);
    const chunkEnd = next === -1 ? source.length : next;
    for (const token of tokenizeXml(source.slice(i, chunkEnd))) {
      tokens.push(token);
    }
    i = chunkEnd;
  }

  return tokens;
}

function tokenizePlain(source: string): Token[] {
  const tokens: Token[] = [];
  withVars(tokens, source, '');
  return tokens;
}

export function languageForContentType(contentType: string): Language {
  const type = contentType.toLowerCase();
  if (type.includes('json')) {
    return 'json';
  }
  if (type.includes('html')) {
    return 'html';
  }
  if (type.includes('xml') || type.includes('svg')) {
    return 'xml';
  }
  if (type.includes('css')) {
    return 'css';
  }
  if (type.includes('javascript') || type.includes('ecmascript')) {
    return 'javascript';
  }
  return 'text';
}

export function highlight(source: string, language: Language): string {
  const tokens =
    language === 'json'
      ? tokenizeJson(source)
      : language === 'xml'
      ? tokenizeXml(source)
      : language === 'html'
      ? tokenizeHtml(source)
      : language === 'css'
      ? tokenizeCss(source)
      : language === 'javascript'
      ? tokenizeJs(source)
      : language === 'graphql'
      ? tokenizeGraphql(source)
      : tokenizePlain(source);

  return render(tokens);
}

function render(tokens: Token[]): string {
  let html = '';
  for (const token of tokens) {
    const escaped = escapeHtml(token.text);
    if (!token.cls) {
      html += escaped;
      continue;
    }
    const title = token.title
      ? ` title="${escapeHtml(token.title).replace(/"/g, '&quot;')}"`
      : '';
    html += `<span class="${token.cls}"${title}>${escaped}</span>`;
  }
  return html;
}

/** Highlights {{variables}} inside a single-line value (URL, header, param). */
export function highlightVars(source: string): string {
  const tokens: Token[] = [];
  withVars(tokens, source, '');
  return render(tokens);
}
