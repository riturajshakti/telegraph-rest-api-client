import { randomUUID } from 'node:crypto';
import { SORT_STEP } from './storage';
import { stripJsonComments } from './jsonc';
import { formatJson, formatXml, formatGraphql } from './formatters';
import type {
  ApiRequest,
  BodyType,
  Collection,
  Environment,
  Folder,
  HttpMethod,
  KeyValue,
} from './types';

export interface TelegraphExport {
  telegraphVersion: string;
  exportedAt: string;
  collection: Collection;
  environments: Environment[];
}

const METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

function asMethod(value: unknown): HttpMethod {
  const upper = String(value ?? 'GET').toUpperCase() as HttpMethod;
  return METHODS.includes(upper) ? upper : 'GET';
}

function now(): string {
  return new Date().toISOString();
}

/* ---------- Telegraph (single file, collection + environments) ---------- */

export function toTelegraph(
  collection: Collection,
  environments: Environment[]
): TelegraphExport {
  const portableCollection: Collection = {
    ...collection,
    ...(collection.settings
      ? {
          settings: {
            ...collection.settings,
            dotenvPath: undefined,
          },
        }
      : {}),
  };

  return {
    telegraphVersion: '1.0',
    exportedAt: now(),
    collection: portableCollection,
    environments: environments.map((env) => ({
      ...env,
      dotenvPath: undefined,
    })),
  };
}

export function fromTelegraph(raw: unknown): {
  collection: Collection;
  environments: Environment[];
} | null {
  const data = raw as Partial<TelegraphExport>;
  if (!data || typeof data !== 'object' || !data.collection) {
    return null;
  }

  const collection = data.collection;
  if (typeof collection._id !== 'string' || !Array.isArray(collection.requests)) {
    return null;
  }

  return {
    collection: reidentify(collection),
    environments: (data.environments ?? []).map((env) => ({
      ...env,
      _id: randomUUID(),
    })),
  };
}

function reidentify(collection: Collection): Collection {
  const folderMap = new Map<string, string>();

  const folders = (collection.folders ?? []).map((folder) => {
    const id = randomUUID();
    folderMap.set(folder._id, id);
    return { ...folder, _id: id };
  });

  for (const folder of folders) {
    if (folder.containerId) {
      folder.containerId = folderMap.get(folder.containerId) ?? '';
    }
  }

  const colId = randomUUID();

  const requests = (collection.requests ?? []).map((request) => ({
    ...request,
    _id: randomUUID(),
    colId,
    containerId: request.containerId
      ? folderMap.get(request.containerId) ?? ''
      : '',
  }));

  return { ...collection, _id: colId, folders, requests };
}

/* ---------- Postman v2.1 ---------- */

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
}

interface PostmanRequest {
  method?: string;
  url?: PostmanUrl | string;
  header?: { key?: string; value?: string; disabled?: boolean }[];
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: { key?: string; value?: string; disabled?: boolean }[];
    formdata?: {
      key?: string;
      value?: string;
      src?: string;
      type?: string;
      disabled?: boolean;
    }[];
    graphql?: { query?: string; variables?: string };
    options?: { raw?: { language?: string } };
  };
  auth?: {
    type?: string;
    bearer?: { key?: string; value?: string }[];
    basic?: { key?: string; value?: string }[];
  };
}

interface PostmanUrl {
  raw?: string;
  query?: { key?: string; value?: string; disabled?: boolean }[];
}

function kvToPostman(items: KeyValue[]): {
  key: string;
  value: string;
  disabled?: boolean;
}[] {
  return items.map((item) => ({
    key: item.name,
    value: item.value,
    ...(item.isDisabled ? { disabled: true } : {}),
  }));
}

function postmanBody(request: ApiRequest): PostmanRequest['body'] {
  const body = request.body;
  if (!body) {
    return undefined;
  }
  switch (body.type) {
    case 'json':
      return {
        mode: 'raw',
        raw: stripJsonComments(body.raw ?? ''),
        options: { raw: { language: 'json' } },
      };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: {
          query: body.raw ?? '',
          variables: stripJsonComments(body.graphqlVariables ?? ''),
        },
      };
    case 'xml':
      return {
        mode: 'raw',
        raw: body.raw ?? '',
        options: { raw: { language: 'xml' } },
      };
    case 'text':
      return { mode: 'raw', raw: body.raw ?? '' };
    case 'formencoded':
      return { mode: 'urlencoded', urlencoded: kvToPostman(body.form ?? []) };
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: (body.form ?? []).map((f) =>
          f.isFile
            ? {
                key: f.name,
                type: 'file',
                src: f.value,
                ...(f.isDisabled ? { disabled: true } : {}),
              }
            : {
                key: f.name,
                value: f.value,
                ...(f.isDisabled ? { disabled: true } : {}),
              }
        ),
      };
    case 'binary':
      return { mode: 'file' };
    default:
      return undefined;
  }
}

function postmanAuth(request: ApiRequest): PostmanRequest['auth'] {
  if (!request.auth) {
    return undefined;
  }
  if (request.auth.type === 'bearer') {
    return {
      type: 'bearer',
      bearer: [{ key: 'token', value: request.auth.bearer ?? '' }],
    };
  }
  if (request.auth.type === 'basic') {
    return {
      type: 'basic',
      basic: [
        { key: 'username', value: request.auth.basic?.username ?? '' },
        { key: 'password', value: request.auth.basic?.password ?? '' },
      ],
    };
  }
  return undefined;
}

export function toPostmanCollection(collection: Collection): unknown {
  const buildItems = (containerId: string): PostmanItem[] => {
    const folders = collection.folders
      .filter((f) => f.containerId === containerId)
      .sort((a, b) => a.sortNum - b.sortNum)
      .map((folder) => ({
        name: folder.name,
        item: buildItems(folder._id),
      }));

    const requests = collection.requests
      .filter((r) => r.containerId === containerId)
      .sort((a, b) => a.sortNum - b.sortNum)
      .map((request) => ({
        name: request.name,
        request: {
          method: request.method,
          header: kvToPostman(request.headers ?? []),
          url: {
            raw: request.url,
            query: kvToPostman(request.params ?? []),
          },
          ...(postmanBody(request) ? { body: postmanBody(request) } : {}),
          ...(postmanAuth(request) ? { auth: postmanAuth(request) } : {}),
        },
      }));

    return [...folders, ...requests];
  };

  return {
    info: {
      _postman_id: collection._id,
      name: collection.colName,
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: buildItems(''),
  };
}

export function toPostmanEnvironment(environment: Environment): unknown {
  return {
    id: environment._id,
    name: environment.name,
    values: environment.data.map((v) => ({
      key: v.name,
      value: v.value,
      enabled: !v.isDisabled,
      type: 'default',
    })),
    _postman_variable_scope: 'environment',
  };
}

function postmanKv(
  items: { key?: string; value?: string; disabled?: boolean }[] | undefined
): KeyValue[] {
  return (items ?? []).map((item) => ({
    name: item.key ?? '',
    value: item.value ?? '',
    ...(item.disabled ? { isDisabled: true } : {}),
  }));
}

function parsePostmanRequest(
  source: PostmanRequest,
  name: string,
  colId: string,
  containerId: string,
  sortNum: number
): ApiRequest {
  const url =
    typeof source.url === 'string' ? source.url : source.url?.raw ?? '';
  const query =
    typeof source.url === 'string' ? [] : postmanKv(source.url?.query);

  const request: ApiRequest = {
    _id: randomUUID(),
    colId,
    containerId,
    name,
    url,
    method: asMethod(source.method),
    sortNum,
    created: now(),
    modified: now(),
    headers: postmanKv(source.header),
    params: query.map((q) => ({ ...q, isPath: false })),
    body: { type: 'none', raw: '', form: [] },
    auth: { type: 'none' },
  };

  const body = source.body;
  if (body?.mode === 'raw') {
    const language = body.options?.raw?.language;
    request.body = {
      type: language === 'xml' ? 'xml' : language === 'json' ? 'json' : 'text',
      raw: body.raw ?? '',
      form: [],
    };
    if (!language && body.raw?.trim().startsWith('{')) {
      request.body.type = 'json';
    }
  } else if (body?.mode === 'urlencoded') {
    request.body = {
      type: 'formencoded',
      raw: '',
      form: postmanKv(body.urlencoded),
    };
  } else if (body?.mode === 'formdata') {
    request.body = {
      type: 'formdata',
      raw: '',
      form: (body.formdata ?? []).map((f) => ({
        name: f.key ?? '',
        value: f.type === 'file' ? f.src ?? '' : f.value ?? '',
        ...(f.type === 'file' ? { isFile: true } : {}),
        ...(f.disabled ? { isDisabled: true } : {}),
      })),
    };
  } else if (body?.mode === 'graphql') {
    request.body = {
      type: 'graphql',
      raw: body.graphql?.query ?? '',
      form: [],
      graphqlVariables: body.graphql?.variables ?? '',
    };
  }

  const auth = source.auth;
  if (auth?.type === 'bearer') {
    request.auth = {
      type: 'bearer',
      bearer: auth.bearer?.find((b) => b.key === 'token')?.value ?? '',
    };
  } else if (auth?.type === 'basic') {
    request.auth = {
      type: 'basic',
      basic: {
        username: auth.basic?.find((b) => b.key === 'username')?.value ?? '',
        password: auth.basic?.find((b) => b.key === 'password')?.value ?? '',
      },
    };
  }

  return request;
}

export function fromPostmanCollection(raw: unknown): Collection | null {
  const data = raw as {
    info?: { name?: string };
    item?: PostmanItem[];
  };

  if (!data?.info || !Array.isArray(data.item)) {
    return null;
  }

  const colId = randomUUID();
  const folders: Folder[] = [];
  const requests: ApiRequest[] = [];

  const walk = (items: PostmanItem[], containerId: string): void => {
    let sort = SORT_STEP;

    for (const item of items) {
      if (Array.isArray(item.item)) {
        const folder: Folder = {
          _id: randomUUID(),
          name: item.name ?? 'Folder',
          containerId,
          created: now(),
          sortNum: sort,
        };
        folders.push(folder);
        walk(item.item, folder._id);
      } else if (item.request) {
        requests.push(
          parsePostmanRequest(
            item.request,
            item.name ?? 'Request',
            colId,
            containerId,
            sort
          )
        );
      }
      sort += SORT_STEP;
    }
  };

  walk(data.item, '');

  return {
    _id: colId,
    colName: data.info.name ?? 'Imported Collection',
    created: now(),
    modified: now(),
    sortNum: SORT_STEP,
    folders,
    requests,
  };
}

export function fromPostmanEnvironment(raw: unknown): Environment | null {
  const data = raw as {
    name?: string;
    values?: { key?: string; value?: string; enabled?: boolean }[];
  };

  if (!data?.name || !Array.isArray(data.values)) {
    return null;
  }

  return {
    _id: randomUUID(),
    name: data.name,
    default: false,
    sortNum: SORT_STEP,
    created: now(),
    modified: now(),
    data: data.values.map((v) => ({
      name: v.key ?? '',
      value: v.value ?? '',
      ...(v.enabled === false ? { isDisabled: true } : {}),
    })),
  };
}

/* ---------- cURL ---------- */

export function parseCurl(input: string): ApiRequest | null {
  const text = input
    .trim()
    .replace(/\\\r?\n/g, ' ')
    .replace(/\s+/g, ' ');

  if (!/^curl\b/i.test(text)) {
    return null;
  }

  const tokens = tokenize(text.replace(/^curl\s*/i, ''));
  const request: ApiRequest = {
    _id: randomUUID(),
    colId: '',
    containerId: '',
    name: 'Imported Request',
    url: '',
    method: 'GET',
    sortNum: 0,
    created: now(),
    modified: now(),
    headers: [],
    params: [],
    body: { type: 'none', raw: '', form: [] },
    auth: { type: 'none' },
  };

  let explicitMethod = false;
  const formFields: KeyValue[] = [];
  const urlencodedFields: KeyValue[] = [];
  let dataSeen = false;
  let binarySeen = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '-X' || token === '--request') {
      request.method = asMethod(tokens[++i]);
      explicitMethod = true;
    } else if (token === '-H' || token === '--header') {
      const raw = tokens[++i] ?? '';
      const sep = raw.indexOf(':');
      if (sep > 0) {
        request.headers.push({
          name: raw.slice(0, sep).trim(),
          value: raw.slice(sep + 1).trim(),
        });
      }
    } else if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary'
    ) {
      const raw = tokens[++i] ?? '';

      // A leading @ means "read the body from this file", not literal text.
      // `--data-raw` is the one flag where @ is not special.
      if (raw.startsWith('@') && token !== '--data-raw') {
        request.body = {
          type: 'binary',
          raw: '',
          form: [],
          binaryPath: raw.slice(1),
        };
        binarySeen = true;
      } else {
        request.body = { type: 'text', raw, form: [] };
        dataSeen = true;
      }

      if (!explicitMethod) {
        request.method = 'POST';
      }
    } else if (token === '--data-urlencode') {
      const raw = tokens[++i] ?? '';
      const sep = raw.indexOf('=');
      if (sep > 0) {
        urlencodedFields.push({
          name: raw.slice(0, sep),
          value: raw.slice(sep + 1),
        });
      }
      if (!explicitMethod) {
        request.method = 'POST';
      }
    } else if (token === '-F' || token === '--form') {
      const raw = tokens[++i] ?? '';
      const sep = raw.indexOf('=');
      if (sep > 0) {
        const value = raw.slice(sep + 1);
        const isFile = value.startsWith('@');
        formFields.push({
          name: raw.slice(0, sep),
          value: isFile ? value.slice(1) : value,
          ...(isFile ? { isFile: true } : {}),
        });
      }
      if (!explicitMethod) {
        request.method = 'POST';
      }
    } else if (token === '-b' || token === '--cookie') {
      const raw = tokens[++i] ?? '';
      request.headers.push({ name: 'Cookie', value: raw });
    } else if (token === '-u' || token === '--user') {
      const raw = tokens[++i] ?? '';
      const sep = raw.indexOf(':');
      request.auth = {
        type: 'basic',
        basic: {
          username: sep > 0 ? raw.slice(0, sep) : raw,
          password: sep > 0 ? raw.slice(sep + 1) : '',
        },
      };
    } else if (token === '-I' || token === '--head') {
      request.method = 'HEAD';
      explicitMethod = true;
    } else if (!token.startsWith('-') && !request.url) {
      request.url = token;
    }
  }

  if (
    dataSeen &&
    !binarySeen &&
    formFields.length === 0 &&
    urlencodedFields.length === 0
  ) {
    const declared =
      request.headers.find((h) => h.name.toLowerCase() === 'content-type')
        ?.value ?? '';
    const resolved = bodyTypeFor(declared, request.body.raw ?? '');
    request.body.type = resolved;

    // GraphQL travels as a JSON envelope; split it back into the query and
    // variables editors.
    if (resolved === 'graphql') {
      try {
        const envelope = JSON.parse(
          stripJsonComments(request.body.raw ?? '')
        ) as { query?: unknown; variables?: unknown };
        if (typeof envelope.query === 'string') {
          request.body.raw = envelope.query;
          request.body.graphqlVariables =
            envelope.variables === undefined
              ? ''
              : JSON.stringify(envelope.variables, null, 2);
        }
      } catch {
        // Not an envelope; leave the text as typed.
      }
    }

    // Pasted commands carry minified bodies; make them readable.
    prettifyBody(request.body);
  }

  if (formFields.length > 0) {
    request.body = { type: 'formdata', raw: '', form: formFields };
  } else if (urlencodedFields.length > 0) {
    request.body = {
      type: 'formencoded',
      raw: '',
      form: urlencodedFields,
    };
  }

  if (!request.url) {
    return null;
  }

  const cookieHeader = request.headers.find(
    (h) => h.name.toLowerCase() === 'cookie'
  );
  if (cookieHeader) {
    request.cookies = cookieHeader.value
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return {
          name: eq < 0 ? pair : pair.slice(0, eq).trim(),
          value: eq < 0 ? '' : pair.slice(eq + 1).trim(),
        };
      });
    request.headers = request.headers.filter((h) => h !== cookieHeader);
  }

  const authHeader = request.headers.find(
    (h) => h.name.toLowerCase() === 'authorization'
  );
  if (authHeader?.value.toLowerCase().startsWith('bearer ')) {
    request.auth = { type: 'bearer', bearer: authHeader.value.slice(7).trim() };
    request.headers = request.headers.filter((h) => h !== authHeader);
  } else if (authHeader?.value.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(
        authHeader.value.slice(6).trim(),
        'base64'
      ).toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0) {
        request.auth = {
          type: 'basic',
          basic: {
            username: decoded.slice(0, sep),
            password: decoded.slice(sep + 1),
          },
        };
        request.headers = request.headers.filter((h) => h !== authHeader);
      }
    } catch {
      // Leave a malformed header alone rather than losing it.
    }
  }

  try {
    const url = new URL(request.url);
    for (const [name, value] of url.searchParams) {
      request.params.push({ name, value, isPath: false });
    }
    request.name = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
  } catch {
    // leave name and params alone for non-absolute URLs
  }

  return request;
}

/**
 * Chooses a body tab from the declared Content-Type, falling back to the shape
 * of the payload when no usable header was given.
 */
/** Pretty-prints a parsed body in place, leaving it untouched if invalid. */
function prettifyBody(body: ApiRequest['body']): void {
  if (body.type === 'json') {
    const formatted = formatJson(body.raw ?? '');
    if (formatted !== null) {
      body.raw = formatted;
    }
    return;
  }

  if (body.type === 'xml') {
    const formatted = formatXml(body.raw ?? '');
    if (formatted !== null) {
      body.raw = formatted;
    }
    return;
  }

  if (body.type === 'graphql') {
    const query = formatGraphql(body.raw ?? '');
    if (query !== null) {
      body.raw = query;
    }
    const variables = formatJson(body.graphqlVariables ?? '');
    if (variables !== null) {
      body.graphqlVariables = variables;
    }
  }
}

function bodyTypeFor(contentType: string, raw: string): BodyType {
  const type = contentType.toLowerCase();
  const text = raw.trim();

  if (type.includes('json')) {
    // A JSON envelope carrying a `query` field is really a GraphQL request.
    if (/^\{[\s\S]*"query"\s*:/.test(text)) {
      return 'graphql';
    }
    return 'json';
  }
  if (type.includes('xml')) {
    return 'xml';
  }
  if (type.includes('graphql')) {
    return 'graphql';
  }
  if (type.includes('text/')) {
    return 'text';
  }

  if (text.startsWith('<')) {
    return 'xml';
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return /^\{[\s\S]*"query"\s*:/.test(text) ? 'graphql' : 'json';
  }
  if (/^\s*(query|mutation|subscription)\b/.test(text)) {
    return 'graphql';
  }

  return 'text';
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/* ---------- cURL generation ---------- */

export function toCurl(request: ApiRequest): string {
  const auth = request.auth ?? { type: 'none' as const };
  const body = request.body ?? { type: 'none' as const };
  const parts: string[] = [`curl --request ${request.method}`];
  const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

  let url = request.url;
  const enabled = (request.params ?? []).filter(
    (p) => !p.isDisabled && !p.isPath && p.name
  );
  if (enabled.length > 0 && !url.includes('?')) {
    const query = enabled
      .map(
        (p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`
      )
      .join('&');
    url = `${url}?${query}`;
  }
  parts.push(quoted(url));

  for (const header of request.headers ?? []) {
    if (!header.isDisabled && header.name) {
      parts.push(`--header ${quoted(`${header.name}: ${header.value}`)}`);
    }
  }

  const cookies = (request.cookies ?? []).filter(
    (c) => !c.isDisabled && c.name
  );
  if (cookies.length > 0) {
    parts.push(
      `--header ${quoted(
        `Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}`
      )}`
    );
  }

  if (auth.type === 'bearer' && auth.bearer) {
    parts.push(
      `--header ${quoted(`Authorization: Bearer ${auth.bearer}`)}`
    );
  } else if (auth.type === 'basic' && auth.basic) {
    parts.push(
      `--user ${quoted(`${auth.basic.username}:${auth.basic.password}`)}`
    );
  }

  if (body.type === 'json') {
    const payload = stripJsonComments(body.raw ?? '').trim();
    if (payload) {
      parts.push(`--data ${quoted(payload)}`);
    }
  } else if (body.type === 'graphql') {
    const variables = stripJsonComments(body.graphqlVariables ?? '').trim();
    let parsed: unknown;
    try {
      parsed = variables ? JSON.parse(variables) : undefined;
    } catch {
      parsed = undefined;
    }
    parts.push(
      `--data ${quoted(
        JSON.stringify({
          query: body.raw ?? '',
          ...(parsed !== undefined ? { variables: parsed } : {}),
        })
      )}`
    );
  } else if (body.type === 'xml' || body.type === 'text') {
    if (body.raw) {
      parts.push(`--data ${quoted(body.raw)}`);
    }
  } else if (body.type === 'formencoded') {
    for (const field of body.form ?? []) {
      if (!field.isDisabled && field.name) {
        parts.push(`--data-urlencode ${quoted(`${field.name}=${field.value}`)}`);
      }
    }
  } else if (body.type === 'formdata') {
    for (const field of body.form ?? []) {
      if (field.isDisabled || !field.name) {
        continue;
      }
      // cURL marks file uploads with a leading @ on the value.
      const value = field.isFile ? `@${field.value}` : field.value;
      parts.push(`--form ${quoted(`${field.name}=${value}`)}`);
    }
  } else if (body.type === 'binary' && body.binaryPath) {
    parts.push(`--data-binary ${quoted(`@${body.binaryPath}`)}`);
  }

  return parts.join(' \\\n  ');
}

/* ---------- OpenAPI (JSON) ---------- */

interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: { url?: string }[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

interface OpenApiOperation {
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters?: {
    name?: string;
    in?: string;
    required?: boolean;
    example?: unknown;
  }[];
  requestBody?: {
    content?: Record<string, { example?: unknown; schema?: unknown }>;
  };
}

export function fromOpenApi(raw: unknown): Collection | null {
  const doc = raw as OpenApiDoc;
  if (!doc || (!doc.openapi && !doc.swagger) || !doc.paths) {
    return null;
  }

  const base =
    doc.servers?.[0]?.url ??
    (doc.host
      ? `${doc.schemes?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}`
      : '');

  const colId = randomUUID();
  const folders: Folder[] = [];
  const requests: ApiRequest[] = [];
  const tagFolders = new Map<string, string>();
  let sort = SORT_STEP;

  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const upper = method.toUpperCase();
      if (!METHODS.includes(upper as HttpMethod)) {
        continue;
      }

      let containerId = '';
      const tag = operation.tags?.[0];
      if (tag) {
        let folderId = tagFolders.get(tag);
        if (!folderId) {
          folderId = randomUUID();
          tagFolders.set(tag, folderId);
          folders.push({
            _id: folderId,
            name: tag,
            containerId: '',
            created: now(),
            sortNum: folders.length * SORT_STEP + SORT_STEP,
          });
        }
        containerId = folderId;
      }

      const params = (operation.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => ({
          name: p.name ?? '',
          value: p.example !== undefined ? String(p.example) : '',
          isPath: false,
          ...(p.required ? {} : { isDisabled: true }),
        }));

      const headers = (operation.parameters ?? [])
        .filter((p) => p.in === 'header')
        .map((p) => ({
          name: p.name ?? '',
          value: p.example !== undefined ? String(p.example) : '',
        }));

      const request: ApiRequest = {
        _id: randomUUID(),
        colId,
        containerId,
        name: operation.summary ?? operation.operationId ?? `${upper} ${path}`,
        url: `${base}${path}`,
        method: upper as HttpMethod,
        sortNum: sort,
        created: now(),
        modified: now(),
        headers,
        params,
        body: { type: 'none', raw: '', form: [] },
        auth: { type: 'none' },
      };

      const json = operation.requestBody?.content?.['application/json'];
      if (json) {
        request.body = {
          type: 'json',
          raw: json.example ? JSON.stringify(json.example, null, 2) : '{}',
          form: [],
        };
      }

      requests.push(request);
      sort += SORT_STEP;
    }
  }

  return {
    _id: colId,
    colName: doc.info?.title ?? 'Imported API',
    created: now(),
    modified: now(),
    sortNum: SORT_STEP,
    folders,
    requests,
  };
}
