export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export const HTTP_METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export interface KeyValue {
  name: string;
  value: string;
  isDisabled?: boolean;
  /** formdata rows may carry a file path instead of a text value. */
  isFile?: boolean;
}

export interface QueryParam extends KeyValue {
  isPath?: boolean;
}

export type BodyType =
  | 'none'
  | 'json'
  | 'text'
  | 'xml'
  | 'formencoded'
  | 'formdata'
  | 'binary'
  | 'graphql';

export interface RequestBody {
  type: BodyType;
  raw?: string;
  form?: KeyValue[];
  files?: KeyValue[];
  binaryPath?: string;
  graphqlVariables?: string;
  /** Per-tab drafts so switching body types never discards what you typed. */
  drafts?: Partial<Record<BodyType, string>>;
  formDrafts?: Partial<Record<BodyType, KeyValue[]>>;
}

export type AuthType = 'none' | 'bearer' | 'basic';

export interface RequestAuth {
  type: AuthType;
  bearer?: string;
  basic?: { username: string; password: string };
}

export interface ApiRequest {
  _id: string;
  cookies?: KeyValue[];
  colId: string;
  containerId: string;
  name: string;
  url: string;
  method: HttpMethod;
  sortNum: number;
  created: string;
  modified: string;
  headers: KeyValue[];
  params: QueryParam[];
  body: RequestBody;
  auth: RequestAuth;
}

export interface Folder {
  _id: string;
  name: string;
  containerId: string;
  created: string;
  sortNum: number;
}

export interface EnvironmentVariable {
  name: string;
  value: string;
  isDisabled?: boolean;
}

export interface Environment {
  _id: string;
  name: string;
  default: boolean;
  sortNum: number;
  created: string;
  modified: string;
  data: EnvironmentVariable[];
  dotenvPath?: string;
}

export type EnvMode = 'none' | 'embedded' | 'linked';

export interface CollectionSettings {
  envMode: EnvMode;
  embeddedEnv?: Pick<Environment, 'name' | 'data'>;
  linkedEnvIds?: string[];
  dotenvPath?: string;
}

export interface Collection {
  _id: string;
  colName: string;
  created: string;
  modified: string;
  sortNum: number;
  settings?: CollectionSettings;
  folders: Folder[];
  requests: ApiRequest[];
}

export interface ResponseTiming {
  total: number;
  dns?: number;
  tcp?: number;
  tls?: number;
  firstByte?: number;
}

export interface RedirectHop {
  status: number;
  statusText: string;
  from: string;
  to: string;
  method: string;
  nextMethod: string;
  durationMs: number;
  setCookie: string[];
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: KeyValue[];
  body: string;
  bodyBytes: number;
  truncated: boolean;
  timing: ResponseTiming;
  redirects: string[];
  hops?: RedirectHop[];
  contentType: string;
}

export interface RequestError {
  message: string;
  code?: string;
}

export type SendResult =
  | { ok: true; response: ApiResponse }
  | { ok: false; error: RequestError };

export interface HistoryEntry {
  _id: string;
  name: string;
  url: string;
  method: HttpMethod;
  status: number;
  statusText: string;
  durationMs: number;
  bytes: number;
  at: string;
  colId: string;
  requestId: string;
  error?: string;
  runCount?: number;
  firstRunAt?: string;
  /** Full request snapshot so reopening restores body, headers, auth, etc. */
  request?: ApiRequest;
}

export function createEmptyRequest(id: string): ApiRequest {
  const now = new Date().toISOString();
  return {
    _id: id,
    colId: '',
    containerId: '',
    name: 'New Request',
    url: '',
    method: 'GET',
    sortNum: 0,
    created: now,
    modified: now,
    headers: [],
    params: [],
    body: { type: 'none', raw: '', form: [] },
    auth: { type: 'none' },
  };
}
