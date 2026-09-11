export interface BodyIssue {
  message: string;
  offset: number;
  line: number;
  column: number;
}

class ParseFailure {
  constructor(
    readonly message: string,
    readonly offset: number
  ) {}
}

const TEMPLATE = /^\{\{\s*[^{}"]+?\s*\}\}/;

export function locate(
  text: string,
  offset: number
): { line: number; column: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart + 1 };
}

function toIssue(text: string, err: unknown): BodyIssue | null {
  if (err instanceof ParseFailure) {
    return {
      message: err.message,
      offset: err.offset,
      ...locate(text, err.offset),
    };
  }
  return null;
}

function describeChar(text: string, at: number): string {
  const code = text.codePointAt(at) ?? 0;
  const invisible =
    code <= 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0xa0) ||
    (code >= 0x2000 && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff;
  return invisible
    ? `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
    : `"${String.fromCodePoint(code)}"`;
}

function templateAt(text: string, at: number): number {
  const match = TEMPLATE.exec(text.slice(at, at + 256));
  return match ? match[0].length : 0;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isHex(c: string | undefined): boolean {
  return (
    c !== undefined &&
    ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
  );
}

type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'template';

export function validateJson(
  text: string,
  options: { objectOnly?: boolean } = {}
): BodyIssue | null {
  const n = text.length;
  let i = 0;

  function fail(message: string, at: number = i): never {
    throw new ParseFailure(message, at);
  }

  function skip(): void {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end === -1 ? n : end;
      } else if (c === '/' && text[i + 1] === '*') {
        fail('Block comments are sent as-is and break the JSON; use // comments instead');
      } else {
        return;
      }
    }
  }

  function string(): void {
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\\') {
        const escape = text[i + 1];
        if (escape === 'u') {
          if (![2, 3, 4, 5].every((k) => isHex(text[i + k]))) {
            fail('Invalid \\u escape; expected four hex digits');
          }
          i += 6;
          continue;
        }
        if (escape !== undefined && !'"\\/bfnrt'.includes(escape)) {
          fail(`Invalid escape sequence "\\${escape}"`);
        }
        i += 2;
        continue;
      }
      if (c === '\n' || c === '\r') {
        fail('Line break inside a string; close the quote or write \\n');
      }
      if (c === '\t') {
        fail('Tab inside a string; write it as \\t');
      }
      if (c < ' ') {
        fail(`Control character ${describeChar(text, i)} inside a string must be escaped`);
      }
      i++;
    }
    fail('Unterminated string; the closing quote is missing', start);
  }

  function number(): void {
    const start = i;
    if (text[i] === '-') {
      i++;
    }
    if (text[i] === '0') {
      i++;
      if (isDigit(text[i])) {
        fail('Numbers cannot have leading zeros', start);
      }
    } else if (isDigit(text[i])) {
      while (isDigit(text[i])) {
        i++;
      }
    } else {
      fail('Invalid number; expected a digit');
    }
    if (text[i] === '.') {
      i++;
      if (!isDigit(text[i])) {
        fail('Invalid number; expected a digit after the decimal point');
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') {
        i++;
      }
      if (!isDigit(text[i])) {
        fail('Invalid number; expected a digit in the exponent');
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
  }

  function object(): void {
    i++;
    skip();
    if (text[i] === '}') {
      i++;
      return;
    }
    let comma = -1;
    for (;;) {
      skip();
      if (text[i] === '"') {
        string();
      } else {
        const length = text[i] === '{' ? templateAt(text, i) : 0;
        if (length > 0) {
          i += length;
        } else if (text[i] === '}' && comma >= 0) {
          fail('Trailing comma is not allowed', comma);
        } else if (i >= n) {
          fail('Unexpected end of input; expected a property name');
        } else if (text[i] === "'") {
          fail('Property names must use double quotes');
        } else {
          fail('Expected a property name in double quotes');
        }
      }
      skip();
      if (text[i] !== ':') {
        fail(
          i >= n
            ? "Unexpected end of input; expected ':'"
            : "Expected ':' after the property name"
        );
      }
      i++;
      value();
      skip();
      if (text[i] === ',') {
        comma = i;
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return;
      }
      fail(
        i >= n
          ? "Unexpected end of input; expected ',' or '}'"
          : "Expected ',' or '}' after the property value"
      );
    }
  }

  function array(): void {
    i++;
    skip();
    if (text[i] === ']') {
      i++;
      return;
    }
    let comma = -1;
    for (;;) {
      skip();
      if (text[i] === ']' && comma >= 0) {
        fail('Trailing comma is not allowed', comma);
      }
      value();
      skip();
      if (text[i] === ',') {
        comma = i;
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return;
      }
      fail(
        i >= n
          ? "Unexpected end of input; expected ',' or ']'"
          : "Expected ',' or ']' after the array item"
      );
    }
  }

  function value(): JsonKind {
    skip();
    if (i >= n) {
      return fail('Unexpected end of input; expected a value');
    }
    const c = text[i];
    if (c === '{') {
      const length = templateAt(text, i);
      if (length > 0) {
        i += length;
        return 'template';
      }
      object();
      return 'object';
    }
    if (c === '[') {
      array();
      return 'array';
    }
    if (c === '"') {
      string();
      return 'string';
    }
    if (c === '-' || isDigit(c)) {
      number();
      return 'number';
    }
    if (c === "'") {
      return fail('Strings must use double quotes');
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64))?.[0];
    if (word === 'true' || word === 'false') {
      i += word.length;
      return 'boolean';
    }
    if (word === 'null') {
      i += 4;
      return 'null';
    }
    if (word) {
      return fail(`Unexpected "${word}"; text values must be in double quotes`);
    }
    return fail(`Unexpected character ${describeChar(text, i)}`);
  }

  try {
    skip();
    if (i >= n) {
      return null;
    }
    const first = i;
    const kind = value();
    skip();
    if (i < n) {
      fail('Unexpected content after the end of the JSON');
    }
    if (
      options.objectOnly &&
      kind !== 'object' &&
      kind !== 'null' &&
      kind !== 'template'
    ) {
      fail('Expected a JSON object, like { "id": 1 }', first);
    }
    return null;
  } catch (err) {
    return toIssue(text, err);
  }
}

type TokenKind = 'punct' | 'name' | 'number' | 'string' | 'template' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
}

const PUNCTUATORS = '!$&()[]{}:=@|';

const TYPE_SYSTEM = new Set([
  'schema',
  'scalar',
  'type',
  'interface',
  'union',
  'enum',
  'input',
  'directive',
  'extend',
]);

function isNameStart(c: string | undefined): boolean {
  return (
    c !== undefined &&
    (c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))
  );
}

function isNameChar(c: string | undefined): boolean {
  return isNameStart(c) || isDigit(c);
}

function isLeadingSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isTrailingSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function lexGraphql(text: string): Token[] {
  const n = text.length;
  const tokens: Token[] = [];
  let i = 0;

  function fail(message: string, at: number = i): never {
    throw new ParseFailure(message, at);
  }

  function number(): void {
    const start = i;
    if (text[i] === '-') {
      i++;
    }
    if (text[i] === '0') {
      i++;
      if (isDigit(text[i])) {
        fail('Invalid number; numbers cannot have leading zeros', start);
      }
    } else if (isDigit(text[i])) {
      while (isDigit(text[i])) {
        i++;
      }
    } else {
      fail('Invalid number; expected a digit');
    }
    if (text[i] === '.') {
      i++;
      if (!isDigit(text[i])) {
        fail('Invalid number; expected a digit after the decimal point');
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') {
        i++;
      }
      if (!isDigit(text[i])) {
        fail('Invalid number; expected a digit in the exponent');
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
    if (text[i] === '.' || isNameStart(text[i])) {
      fail(`Invalid number; unexpected ${describeChar(text, i)}`);
    }
  }

  function unicodeEscape(): void {
    if (text[i + 2] === '{') {
      let j = i + 3;
      while (isHex(text[j]) && j - (i + 3) < 8) {
        j++;
      }
      const digits = text.slice(i + 3, j);
      const code = digits ? parseInt(digits, 16) : -1;
      if (
        text[j] !== '}' ||
        code < 0 ||
        code > 0x10ffff ||
        isLeadingSurrogate(code) ||
        isTrailingSurrogate(code)
      ) {
        fail('Invalid Unicode escape sequence');
      }
      i = j + 1;
      return;
    }

    if (![2, 3, 4, 5].every((k) => isHex(text[i + k]))) {
      fail('Invalid Unicode escape sequence');
    }
    const code = parseInt(text.slice(i + 2, i + 6), 16);
    if (isLeadingSurrogate(code)) {
      const pair = text.slice(i + 6, i + 12);
      const trailing = /^\\u[0-9a-fA-F]{4}$/.test(pair)
        ? parseInt(pair.slice(2), 16)
        : -1;
      if (!isTrailingSurrogate(trailing)) {
        fail('Invalid Unicode escape sequence');
      }
      i += 12;
      return;
    }
    if (isTrailingSurrogate(code)) {
      fail('Invalid Unicode escape sequence');
    }
    i += 6;
  }

  function string(): void {
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\n' || c === '\r') {
        fail('Unterminated string; use """block strings""" for text that spans lines', start);
      }
      if (c === '\\') {
        const escape = text[i + 1];
        if (escape === 'u') {
          unicodeEscape();
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          fail(`Invalid escape sequence "\\${escape ?? ''}"`);
        }
        i += 2;
        continue;
      }
      const code = text.charCodeAt(i);
      if (isLeadingSurrogate(code) && isTrailingSurrogate(text.charCodeAt(i + 1))) {
        i += 2;
        continue;
      }
      if (isLeadingSurrogate(code) || isTrailingSurrogate(code)) {
        fail('Invalid character inside a string');
      }
      i++;
    }
    fail('Unterminated string', start);
  }

  function blockString(): void {
    const start = i;
    i += 3;
    while (i < n) {
      if (text.startsWith('\\"""', i)) {
        i += 4;
        continue;
      }
      if (text.startsWith('"""', i)) {
        i += 3;
        return;
      }
      i++;
    }
    fail('Unterminated block string', start);
  }

  while (i < n) {
    const c = text[i];
    const start = i;

    if (c === ' ' || c === '\t' || c === ',' || c === '\n' || c === '\r' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') {
        i++;
      }
      continue;
    }
    if (c === '{') {
      const length = templateAt(text, i);
      if (length > 0) {
        tokens.push({ kind: 'template', value: text.slice(i, i + length), start });
        i += length;
        continue;
      }
    }
    if (PUNCTUATORS.includes(c)) {
      tokens.push({ kind: 'punct', value: c, start });
      i++;
      continue;
    }
    if (c === '.') {
      if (text.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...', start });
        i += 3;
        continue;
      }
      fail('Unexpected "."; a fragment spread is written "..."');
    }
    if (isNameStart(c)) {
      while (isNameChar(text[i])) {
        i++;
      }
      tokens.push({ kind: 'name', value: text.slice(start, i), start });
      continue;
    }
    if (c === '-' || isDigit(c)) {
      number();
      tokens.push({ kind: 'number', value: text.slice(start, i), start });
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        blockString();
      } else {
        string();
      }
      tokens.push({ kind: 'string', value: text.slice(start, i), start });
      continue;
    }
    fail(`Unexpected character ${describeChar(text, i)}`);
  }

  tokens.push({ kind: 'eof', value: '', start: n });
  return tokens;
}

export function validateGraphql(text: string): BodyIssue | null {
  let tokens: Token[];
  try {
    tokens = lexGraphql(text);
  } catch (err) {
    return toIssue(text, err);
  }

  if (tokens.length === 1) {
    return null;
  }

  let p = 0;

  function peek(): Token {
    return tokens[p];
  }

  function found(token: Token): string {
    switch (token.kind) {
      case 'eof':
        return 'the end of the query';
      case 'string':
        return 'a string';
      case 'number':
        return `the number ${token.value}`;
      default:
        return `"${token.value}"`;
    }
  }

  function fail(expected: string, token: Token = peek()): never {
    throw new ParseFailure(`Expected ${expected}, found ${found(token)}`, token.start);
  }

  function isPunct(value: string): boolean {
    const token = peek();
    return token.kind === 'punct' && token.value === value;
  }

  function isName(value?: string): boolean {
    const token = peek();
    return token.kind === 'name' && (value === undefined || token.value === value);
  }

  function expectPunct(value: string, expected: string = `"${value}"`): void {
    if (!isPunct(value)) {
      fail(expected);
    }
    p++;
  }

  function expectName(expected: string): string {
    if (!isName()) {
      fail(expected);
    }
    return tokens[p++].value;
  }

  function variable(): void {
    expectPunct('$', '"$" to start a variable');
    expectName('a variable name');
  }

  function value(constant: boolean): void {
    const token = peek();
    if (
      token.kind === 'template' ||
      token.kind === 'number' ||
      token.kind === 'string' ||
      token.kind === 'name'
    ) {
      p++;
      return;
    }
    if (isPunct('$')) {
      if (constant) {
        throw new ParseFailure('Variables are not allowed in default values', token.start);
      }
      variable();
      return;
    }
    if (isPunct('[')) {
      p++;
      while (!isPunct(']')) {
        value(constant);
      }
      p++;
      return;
    }
    if (isPunct('{')) {
      p++;
      while (!isPunct('}')) {
        expectName('an object field name');
        expectPunct(':', '":" after the object field name');
        value(constant);
      }
      p++;
      return;
    }
    fail('a value');
  }

  function type(): void {
    if (isPunct('[')) {
      p++;
      type();
      expectPunct(']', '"]" to close the list type');
    } else {
      expectName('a type name');
    }
    if (isPunct('!')) {
      p++;
    }
  }

  function args(constant: boolean): void {
    p++;
    if (isPunct(')')) {
      fail('an argument name');
    }
    while (!isPunct(')')) {
      expectName('an argument name');
      expectPunct(':', '":" after the argument name');
      value(constant);
    }
    p++;
  }

  function directives(constant: boolean): void {
    while (isPunct('@')) {
      p++;
      expectName('a directive name');
      if (isPunct('(')) {
        args(constant);
      }
    }
  }

  function selectionSet(): void {
    expectPunct('{', '"{" to start a selection set');
    if (isPunct('}')) {
      fail('a field, fragment spread or inline fragment');
    }
    while (!isPunct('}')) {
      selection();
    }
    p++;
  }

  function selection(): void {
    if (isPunct('...')) {
      p++;
      if (isName('on')) {
        p++;
        expectName('a type name after "on"');
        directives(false);
        selectionSet();
        return;
      }
      if (isName()) {
        p++;
        directives(false);
        return;
      }
      directives(false);
      selectionSet();
      return;
    }
    expectName('a field name');
    if (isPunct(':')) {
      p++;
      expectName('a field name after the alias');
    }
    if (isPunct('(')) {
      args(false);
    }
    directives(false);
    if (isPunct('{')) {
      selectionSet();
    }
  }

  function variableDefinitions(): void {
    p++;
    if (isPunct(')')) {
      fail('a variable definition');
    }
    while (!isPunct(')')) {
      variable();
      expectPunct(':', '":" after the variable name');
      type();
      if (isPunct('=')) {
        p++;
        value(true);
      }
      directives(true);
    }
    p++;
  }

  function definition(): void {
    const token = peek();
    if (isPunct('{')) {
      selectionSet();
      return;
    }
    if (isName('query') || isName('mutation') || isName('subscription')) {
      p++;
      if (isName()) {
        p++;
      }
      if (isPunct('(')) {
        variableDefinitions();
      }
      directives(false);
      selectionSet();
      return;
    }
    if (isName('fragment')) {
      p++;
      const nameToken = peek();
      const name = expectName('a fragment name');
      if (name === 'on') {
        throw new ParseFailure('A fragment cannot be named "on"', nameToken.start);
      }
      if (!isName('on')) {
        fail('"on" and a type condition');
      }
      p++;
      expectName('a type name after "on"');
      directives(false);
      selectionSet();
      return;
    }
    if (token.kind === 'name' && TYPE_SYSTEM.has(token.value)) {
      throw new ParseFailure(
        `"${token.value}" defines a schema; only queries, mutations, subscriptions and fragments can be sent`,
        token.start
      );
    }
    fail('"query", "mutation", "subscription", "fragment" or "{"');
  }

  try {
    while (peek().kind !== 'eof') {
      definition();
    }
    return null;
  } catch (err) {
    return toIssue(text, err);
  }
}
