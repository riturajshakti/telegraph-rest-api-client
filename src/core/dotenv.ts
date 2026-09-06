import type { EnvironmentVariable } from './types';

export interface DotenvResult {
  variables: EnvironmentVariable[];
  errors: string[];
}

/**
 * Parses a .env file. Handles `export` prefixes, single/double/backtick quoted
 * values, escape sequences inside double quotes, inline comments on unquoted
 * values, and multi-line quoted values.
 */
export function parseDotenv(source: string): DotenvResult {
  const variables: EnvironmentVariable[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');

    if (eq < 0) {
      errors.push(`Line ${lineNo}: missing "=" — skipped`);
      continue;
    }

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
      errors.push(`Line ${lineNo}: invalid variable name "${name}" — skipped`);
      continue;
    }

    let rest = withoutExport.slice(eq + 1).trim();
    let value: string;

    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let body = rest.slice(1);
      let closed = body.includes(quote);

      while (!closed && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i]}`;
        closed = lines[i].includes(quote);
      }

      if (!closed) {
        errors.push(`Line ${lineNo}: unterminated ${quote} quote — skipped`);
        continue;
      }

      const end = body.lastIndexOf(quote);
      value = body.slice(0, end);

      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const hash = rest.indexOf(' #');
      if (hash >= 0) {
        rest = rest.slice(0, hash);
      }
      value = rest.trim();
    }

    if (seen.has(name)) {
      const existing = variables.find((v) => v.name === name);
      if (existing) {
        existing.value = value;
      }
      continue;
    }

    seen.add(name);
    variables.push({ name, value });
  }

  return { variables, errors };
}

export function toDotenv(variables: EnvironmentVariable[]): string {
  return variables
    .filter((v) => v.name)
    .map((v) => {
      const needsQuotes =
        v.value === '' ||
        /[\s#'"`$]/.test(v.value) ||
        v.value !== v.value.trim();

      if (!needsQuotes) {
        return `${v.name}=${v.value}`;
      }

      const escaped = v.value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');

      return `${v.name}="${escaped}"`;
    })
    .join('\n');
}
