export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export function parseSetCookie(header: string): Cookie | null {
  const parts = header.split(';');
  const first = parts.shift();
  if (!first) {
    return null;
  }

  const eq = first.indexOf('=');
  if (eq < 0) {
    return null;
  }

  const cookie: Cookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    secure: false,
    httpOnly: false,
  };

  for (const part of parts) {
    const trimmed = part.trim();
    const sep = trimmed.indexOf('=');
    const key = (sep < 0 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
    const value = sep < 0 ? '' : trimmed.slice(sep + 1).trim();

    switch (key) {
      case 'domain':
        cookie.domain = value;
        break;
      case 'path':
        cookie.path = value;
        break;
      case 'expires':
        cookie.expires = value;
        break;
      case 'max-age':
        cookie.maxAge = value;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = value;
        break;
    }
  }

  return cookie;
}

export function serializeCookie(cookie: Cookie): string {
  const parts = [`${cookie.name}=${cookie.value}`];
  if (cookie.domain) {
    parts.push(`Domain=${cookie.domain}`);
  }
  if (cookie.path) {
    parts.push(`Path=${cookie.path}`);
  }
  if (cookie.expires) {
    parts.push(`Expires=${cookie.expires}`);
  }
  if (cookie.maxAge) {
    parts.push(`Max-Age=${cookie.maxAge}`);
  }
  if (cookie.sameSite) {
    parts.push(`SameSite=${cookie.sameSite}`);
  }
  if (cookie.secure) {
    parts.push('Secure');
  }
  if (cookie.httpOnly) {
    parts.push('HttpOnly');
  }
  return parts.join('; ');
}

/** Builds the `Cookie:` request header value from a set of cookies. */
export function toCookieHeader(cookies: Cookie[]): string {
  return cookies
    .filter((c) => c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export function parseCookieHeader(header: string): Cookie[] {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return {
        name: eq < 0 ? part : part.slice(0, eq).trim(),
        value: eq < 0 ? '' : part.slice(eq + 1).trim(),
        secure: false,
        httpOnly: false,
      };
    });
}
