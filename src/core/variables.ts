import type {
  ApiRequest,
  Collection,
  Environment,
  EnvironmentVariable,
  KeyValue,
} from './types';

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 10;

export interface VariableScope {
  values: Map<string, string>;
  sources: Map<string, string>;
}

function addAll(
  scope: VariableScope,
  vars: EnvironmentVariable[] | undefined,
  source: string
): void {
  for (const variable of vars ?? []) {
    if (variable.isDisabled || !variable.name.trim()) {
      continue;
    }
    scope.values.set(variable.name, variable.value);
    scope.sources.set(variable.name, source);
  }
}

export function buildScope(
  collection: Collection | undefined,
  environments: Environment[],
  activeEnvId: string | null
): VariableScope {
  const scope: VariableScope = { values: new Map(), sources: new Map() };

  const active = environments.find((e) => e._id === activeEnvId);
  if (active) {
    addAll(scope, active.data, `env: ${active.name}`);
  }

  const settings = collection?.settings;

  if (settings?.envMode === 'linked') {
    for (const id of settings.linkedEnvIds ?? []) {
      const linked = environments.find((e) => e._id === id);
      if (linked && linked._id !== activeEnvId) {
        addAll(scope, linked.data, `env: ${linked.name}`);
      }
    }
  }

  if (settings?.envMode === 'embedded' && settings.embeddedEnv) {
    addAll(
      scope,
      settings.embeddedEnv.data,
      `collection: ${collection?.colName ?? ''}`
    );
  }

  return scope;
}

export function resolve(input: string, scope: VariableScope): string {
  if (!input || !input.includes('{{')) {
    return input;
  }

  let current = input;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let replaced = false;

    const next = current.replace(VAR_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      const value = scope.values.get(name);
      if (value === undefined) {
        return match;
      }
      replaced = true;
      return value;
    });

    current = next;
    if (!replaced || !current.includes('{{')) {
      break;
    }
  }

  return current;
}

export function findUnresolved(input: string, scope: VariableScope): string[] {
  const missing: string[] = [];
  for (const match of input.matchAll(VAR_PATTERN)) {
    const name = match[1].trim();
    if (!scope.values.has(name) && !missing.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

function resolveKeyValues<T extends KeyValue>(
  items: T[] | undefined,
  scope: VariableScope
): T[] {
  return (items ?? []).map((item) => ({
    ...item,
    name: resolve(item.name, scope),
    value: resolve(item.value, scope),
  }));
}

export function resolveRequest(
  request: ApiRequest,
  scope: VariableScope
): ApiRequest {
  const resolved: ApiRequest = {
    ...request,
    url: resolve(request.url, scope),
    headers: resolveKeyValues(request.headers, scope),
    params: resolveKeyValues(request.params, scope),
    body: {
      ...request.body,
      raw: request.body.raw ? resolve(request.body.raw, scope) : request.body.raw,
      form: resolveKeyValues(request.body.form, scope),
      binaryPath: request.body.binaryPath
        ? resolve(request.body.binaryPath, scope)
        : request.body.binaryPath,
    },
    auth: { ...request.auth },
  };

  if (resolved.auth.type === 'bearer' && resolved.auth.bearer) {
    resolved.auth.bearer = resolve(resolved.auth.bearer, scope);
  } else if (resolved.auth.type === 'basic' && resolved.auth.basic) {
    resolved.auth.basic = {
      username: resolve(resolved.auth.basic.username, scope),
      password: resolve(resolved.auth.basic.password, scope),
    };
  }

  return resolved;
}

export function collectUnresolved(
  request: ApiRequest,
  scope: VariableScope
): string[] {
  const found = new Set<string>();
  const scan = (text: string | undefined): void => {
    if (!text) {
      return;
    }
    for (const name of findUnresolved(text, scope)) {
      found.add(name);
    }
  };

  scan(request.url);
  for (const header of request.headers ?? []) {
    scan(header.name);
    scan(header.value);
  }
  for (const param of request.params ?? []) {
    scan(param.name);
    scan(param.value);
  }
  scan(request.body.raw);
  for (const field of request.body.form ?? []) {
    scan(field.name);
    scan(field.value);
  }
  if (request.auth.type === 'bearer') {
    scan(request.auth.bearer);
  } else if (request.auth.type === 'basic') {
    scan(request.auth.basic?.username);
    scan(request.auth.basic?.password);
  }

  return [...found];
}
