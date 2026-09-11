import { el, clear } from './dom';
import { KeyValueTable } from './components/kv-table';
import { Dropdown, type DropdownOption } from './components/dropdown';
import { Segmented } from './components/segmented';
import { CodeEditor } from './components/code-editor';
import { VarInput } from './components/var-input';
import {
  languageForContentType,
  setKnownVariables,
  type Language,
} from './components/highlight';
import { parseSetCookie, type Cookie } from '../core/cookies';
import { FoldedView } from './components/folded-view';
import { FindBar } from './components/find-bar';
import { renderHead } from './components/hex-view';
import { IssueBanner, validateXml } from './components/body-issues';
import { validateGraphql, validateJson } from '../core/validate';
import { HTTP_METHODS } from '../core/types';
import type {
  ApiRequest,
  ApiResponse,
  AuthType,
  BodyType,
  HttpMethod,
  SendResult,
  SocketCloseInfo,
  SocketEntry,
  WebSocketInfo,
} from '../core/types';
import type { HostToWebview, WebviewToHost } from '../core/messages';
import {
  formatJson,
  formatXml,
  formatGraphql,
} from '../core/formatters';
import {
  toRawHttp,
  toRawHttpResponse,
  fromRawHttp,
  type SentBodyInfo,
  type SentFileInfo,
} from '../core/raw-http';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
};

const vscode = acquireVsCodeApi();

const SPLIT_KEY = 'telegraph.splitHeight';
let pendingFilePick: ((path: string) => void) | null = null;
const SPLIT_W_KEY = 'telegraph.splitWidth';
const WIDE_AT = 900;
const SOCKET_ROW_LIMIT = 2000;

const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'formdata', label: 'Form' },
  { value: 'formencoded', label: 'Form Encode' },
  { value: 'binary', label: 'Binary' },
  { value: 'graphql', label: 'GraphQL' },
];

const LANGUAGE_FOR: Partial<Record<BodyType, Language>> = {
  json: 'json',
  xml: 'xml',
  graphql: 'graphql',
  text: 'text',
};

const ISSUE_LABEL: Partial<Record<BodyType, string>> = {
  json: 'JSON',
  xml: 'XML',
  graphql: 'GraphQL query',
};

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic' },
  { value: 'bearer', label: 'Bearer' },
];

class RequestView {
  private request!: ApiRequest;

  private methodDropdown!: Dropdown<HttpMethod>;
  private urlField!: VarInput;
  private sendButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private curlButton!: HTMLButtonElement;
  private toCollectionButton!: HTMLButtonElement;
  private nameInput!: HTMLInputElement;
  private dirty = false;
  private saved = false;

  private paramsTable!: KeyValueTable;
  private headersTable!: KeyValueTable;
  private cookieTable!: KeyValueTable;

  private bodyTypeTabs!: Segmented<BodyType>;
  private bodyEditor!: CodeEditor;
  private gqlVarsEditor!: CodeEditor;
  private gqlVarsWrap!: HTMLDivElement;
  private bodyFormTable!: KeyValueTable;
  private bodyFormEncodedTable!: KeyValueTable;
  private bodyFormWrap!: HTMLDivElement;
  private bodyFormEncodedWrap!: HTMLDivElement;
  private bodyRawWrap!: HTMLDivElement;
  private bodyBinaryWrap!: HTMLDivElement;
  private binaryPathLabel!: HTMLSpanElement;
  private formatBtn!: HTMLButtonElement;
  private bodyIssue!: IssueBanner;
  private varsIssue!: IssueBanner;
  private bodyCheckTimer = 0;

  private authTypeTabs!: Segmented<AuthType>;
  private authFields!: HTMLDivElement;

  private tabPanels = new Map<string, HTMLElement>();
  private tabButtons = new Map<string, HTMLButtonElement>();

  private responseArea!: HTMLDivElement;
  private rawEditor!: CodeEditor;
  private rawError!: HTMLDivElement;
  private rawApplyButton!: HTMLButtonElement;
  private rawRevertButton!: HTMLButtonElement;
  private rawDirty = false;
  private rawFileActions!: HTMLDivElement;
  private rawHexSwitches!: HTMLElement;
  private lastSentBody: SentBodyInfo | undefined;
  private loadedFileBytes = new Map<string, string>();
  private responseFind: FindBar | null = null;
  private uploadBar: HTMLDivElement | null = null;
  private uploadLabel: HTMLDivElement | null = null;

  private socketInfo: WebSocketInfo | null = null;
  private socketState: 'none' | 'connecting' | 'open' | 'closed' = 'none';
  private socketLastClose: SocketCloseInfo | null = null;
  private socketLog: HTMLElement | null = null;
  private socketMessages = 0;
  private socketTabButton: HTMLButtonElement | null = null;
  private socketBadge: HTMLElement | null = null;
  private socketComposer!: CodeEditor;
  private socketEventInput!: HTMLInputElement;
  private socketEventRow!: HTMLElement;
  private socketStatus!: HTMLElement;
  private socketSendButton!: HTMLButtonElement;
  private socketCloseButton!: HTMLButtonElement;

  mount(root: HTMLElement): void {
    clear(root);

    const requestPane = el('div', { class: 'pane pane-request' }, [
      this.buildTabs(),
    ]);
    const splitter = el('div', {
      class: 'splitter',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'data-splitter': 'true',
      tabindex: '0',
      title: 'Drag to resize',
    });
    const responsePane = el('div', { class: 'pane pane-response' }, [
      this.buildResponse(),
    ]);

    const split = el('div', { class: 'split' }, [
      requestPane,
      splitter,
      responsePane,
    ]);

    root.append(
      el('div', { class: 'layout' }, [this.buildUrlBar(), split])
    );

    this.setupSplitter(splitter, requestPane, split);
    this.watchOrientation(split);
  }

  private watchOrientation(split: HTMLElement): void {
    const apply = (): void => {
      const wide = split.getBoundingClientRect().width >= WIDE_AT;
      split.classList.toggle('horizontal', wide);
      const pane = split.querySelector<HTMLElement>('.pane-request');
      if (!pane) {
        return;
      }
      const stored = Number(
        localStorage.getItem(wide ? SPLIT_W_KEY : SPLIT_KEY)
      );
      if (wide) {
        pane.style.height = '';
        pane.style.width = Number.isFinite(stored) && stored > 200
          ? `${stored}px`
          : '';
      } else {
        pane.style.width = '';
        pane.style.height = Number.isFinite(stored) && stored > 120
          ? `${stored}px`
          : '';
      }
    };

    apply();
    new ResizeObserver(apply).observe(split);
  }

  private setupSplitter(
    splitter: HTMLElement,
    requestPane: HTMLElement,
    split: HTMLElement
  ): void {
    const MIN = 160;
    const isWide = (): boolean => split.classList.contains('horizontal');

    const apply = (size: number): void => {
      const rect = split.getBoundingClientRect();
      const total = isWide() ? rect.width : rect.height;
      const max = total - MIN;
      const clamped = Math.max(MIN, Math.min(size, Math.max(MIN, max)));
      if (isWide()) {
        requestPane.style.width = `${clamped}px`;
        localStorage.setItem(SPLIT_W_KEY, String(Math.round(clamped)));
      } else {
        requestPane.style.height = `${clamped}px`;
        localStorage.setItem(SPLIT_KEY, String(Math.round(clamped)));
      }
    };

    splitter.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
      document.body.classList.add('resizing');

      const wide = isWide();
      const startPos = wide ? event.clientX : event.clientY;
      const rect = requestPane.getBoundingClientRect();
      const startSize = wide ? rect.width : rect.height;

      const onMove = (move: PointerEvent): void => {
        const now = wide ? move.clientX : move.clientY;
        apply(startSize + (now - startPos));
      };

      const onUp = (): void => {
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onUp);
        splitter.removeEventListener('pointercancel', onUp);
      };

      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
      splitter.addEventListener('pointercancel', onUp);
    });

    splitter.addEventListener('keydown', (event: KeyboardEvent) => {
      const step = event.shiftKey ? 40 : 12;
      const rect = requestPane.getBoundingClientRect();
      const current = isWide() ? rect.width : rect.height;
      const less = isWide() ? 'ArrowLeft' : 'ArrowUp';
      const more = isWide() ? 'ArrowRight' : 'ArrowDown';

      if (event.key === less) {
        event.preventDefault();
        apply(current - step);
      } else if (event.key === more) {
        event.preventDefault();
        apply(current + step);
      }
    });

    splitter.addEventListener('dblclick', () => {
      requestPane.style.height = '';
      requestPane.style.width = '';
      localStorage.removeItem(isWide() ? SPLIT_W_KEY : SPLIT_KEY);
    });
  }

  private buildUrlBar(): HTMLElement {
    this.nameInput = el('input', {
      type: 'text',
      class: 'request-name',
      placeholder: 'Request name',
    }) as HTMLInputElement;
    this.nameInput.addEventListener('change', () => {
      this.request.name = this.nameInput.value;
      this.markDirty();
    });

    const methodOptions: DropdownOption<HttpMethod>[] = HTTP_METHODS.map(
      (method) => ({
        value: method,
        label: method,
        className: `method-${method}`,
      })
    );
    this.methodDropdown = new Dropdown<HttpMethod>(
      methodOptions,
      'GET',
      (value) => {
        this.request.method = value;
        this.syncBodyTabVisibility();
        this.applyMethodDefaultTab();
        this.markDirty();
      },
      'dd-method'
    );

    this.urlField = new VarInput(
      'Paste a URL or a cURL command',
      'url-input',
      () => this.markDirty()
    );
    this.urlField.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.send();
      }
    });

    this.urlField.input.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain')?.trim();
      if (!text || !/^curl\s/i.test(text)) {
        return;
      }
      event.preventDefault();
      vscode.postMessage({ type: 'parseCurl', text });
    });

    this.sendButton = el('button', { class: 'btn btn-primary send-btn' }, [
      'Send',
    ]) as HTMLButtonElement;
    this.sendButton.addEventListener('click', () => this.send());

    this.saveButton = el('button', { class: 'btn btn-ghost save-btn' }, [
      'Save',
    ]) as HTMLButtonElement;
    this.saveButton.addEventListener('click', () => this.save());

    this.toCollectionButton = el('button', {
      class: 'btn btn-ghost to-collection-btn',
      type: 'button',
      title: 'Save a copy into a collection',
      'aria-label': 'Save into a collection',
    }, ['+ Collection']) as HTMLButtonElement;
    this.toCollectionButton.addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveToCollection',
        request: this.collect(),
      });
    });

    this.curlButton = el('button', {
      class: 'btn btn-ghost curl-btn',
      type: 'button',
      title: 'Copy this request as a cURL command',
      'aria-label': 'Copy as cURL',
    }, ['⧉ cURL']) as HTMLButtonElement;
    this.curlButton.addEventListener('click', () => {
      if (!this.urlField.getValue().trim()) {
        this.flashToast('Nothing to copy — enter a URL first');
        return;
      }
      vscode.postMessage({ type: 'buildCurl', request: this.collect() });
    });

    return el('div', { class: 'url-bar-wrap' }, [
      el('div', { class: 'name-row' }, [
        this.nameInput,
        this.toCollectionButton,
        this.curlButton,
        this.saveButton,
      ]),
      el('div', { class: 'url-bar' }, [
        this.methodDropdown.element,
        this.urlField.element,
        this.sendButton,
      ]),
    ]);
  }

  private buildTabs(): HTMLElement {
    const tabBar = el('div', { class: 'tab-bar' });
    const panels = el('div', { class: 'tab-panels' });

    const definitions: { id: string; label: string; body: HTMLElement }[] = [
      { id: 'params', label: 'Query', body: this.buildParamsPanel() },
      { id: 'headers', label: 'Headers', body: this.buildHeadersPanel() },
      { id: 'body', label: 'Body', body: this.buildBodyPanel() },
      { id: 'auth', label: 'Auth', body: this.buildAuthPanel() },
      { id: 'cookies', label: 'Cookies', body: this.buildRequestCookiesPanel() },
      { id: 'raw', label: 'Raw', body: this.buildRawPanel() },
      { id: 'socket', label: 'Socket', body: this.buildSocketPanel() },
    ];

    for (const def of definitions) {
      const button = el('button', { class: 'tab-btn' }, [
        def.label,
      ]) as HTMLButtonElement;
      button.addEventListener('click', () => this.selectTab(def.id));
      tabBar.append(button);
      this.tabButtons.set(def.id, button);

      const panel = el('div', { class: 'tab-panel' }, [def.body]);
      panels.append(panel);
      this.tabPanels.set(def.id, panel);
    }

    this.tabButtons.get('socket')?.classList.add('hidden');

    tabBar.append(this.buildFollowSwitch());

    const wrap = el('div', { class: 'request-section' }, [tabBar, panels]);
    this.selectTab('params');
    return wrap;
  }

  private syncBodyTabVisibility(): void {
    const method = this.methodDropdown.getValue();
    const bodyless = method === 'GET' || method === 'HEAD';
    const button = this.tabButtons.get('body');
    button?.classList.toggle('hidden', bodyless);

    if (bodyless && button?.classList.contains('active')) {
      this.selectTab('params');
    }
  }

  /** Methods that usually carry a payload open on the Body tab. */
  private static bodyFirst(method: HttpMethod): boolean {
    return method === 'POST' || method === 'PUT' || method === 'PATCH';
  }

  /** Picks the body sub-tab holding data, else JSON. */
  private preferredBodyType(): BodyType {
    const body = this.request.body;

    if (body.type !== 'none') {
      return body.type;
    }

    const drafts = body.drafts ?? {};
    for (const type of ['json', 'xml', 'text', 'graphql'] as BodyType[]) {
      if ((drafts[type] ?? '').trim()) {
        return type;
      }
    }

    const formDrafts = body.formDrafts ?? {};
    for (const type of ['formdata', 'formencoded'] as BodyType[]) {
      if ((formDrafts[type] ?? []).some((f) => f.name || f.value)) {
        return type;
      }
    }

    if (body.binaryPath) {
      return 'binary';
    }

    return 'json';
  }

  /** Chooses the tab that matches the current method. */
  private applyMethodDefaultTab(): void {
    const method = this.methodDropdown.getValue();

    if (RequestView.bodyFirst(method)) {
      const preferred = this.preferredBodyType();
      if (this.request.body.type !== preferred) {
        this.stashBodyDraft();
        this.request.body.type = preferred;
        this.bodyTypeTabs.setValue(preferred);
        this.restoreBodyDraft();
        this.syncBodyVisibility();
      }
      this.selectTab('body');
      return;
    }

    this.selectTab('params');
  }

  private selectTab(id: string): void {
    if (id === 'raw' && !this.rawDirty) {
      this.refreshRaw();
    }
    for (const [key, panel] of this.tabPanels) {
      panel.classList.toggle('active', key === id);
    }
    for (const [key, button] of this.tabButtons) {
      button.classList.toggle('active', key === id);
    }
  }

  private buildParamsPanel(): HTMLElement {
    this.paramsTable = new KeyValueTable('Parameter', 'Value', () => {
      this.request.params = this.paramsTable.getRows();
      this.markDirty();
    });
    return this.paramsTable.element;
  }

  private buildHeadersPanel(): HTMLElement {
    this.headersTable = new KeyValueTable('Header', 'Value', () => {
      this.request.headers = this.headersTable.getRows();
      this.markDirty();
    });
    return this.headersTable.element;
  }

  private buildBodyPanel(): HTMLElement {
    this.bodyTypeTabs = new Segmented<BodyType>(BODY_TYPES, 'none', (value) => {
      this.stashBodyDraft();
      this.request.body.type = value;
      this.restoreBodyDraft();
      this.syncBodyVisibility();
      this.markDirty();
    });

    this.bodyEditor = new CodeEditor('{\n  "key": "value"\n}', () => {
      this.request.body.raw = this.bodyEditor.getValue();
      this.markDirty();
      this.scheduleBodyCheck();
    });

    this.gqlVarsEditor = new CodeEditor('{\n  "id": "123"\n}', () => {
      this.request.body.graphqlVariables = this.gqlVarsEditor.getValue();
      this.markDirty();
      this.scheduleBodyCheck();
    });
    this.gqlVarsEditor.setLanguage('json');

    this.bodyIssue = new IssueBanner((offset) =>
      this.bodyEditor.revealOffset(offset)
    );
    this.varsIssue = new IssueBanner((offset) =>
      this.gqlVarsEditor.revealOffset(offset)
    );

    this.formatBtn = el(
      'button',
      {
        class: 'icon-btn format-btn',
        type: 'button',
        title: 'Format (Shift+Alt+F)',
        'aria-label': 'Format body',
      },
      ['{ }']
    ) as HTMLButtonElement;
    this.formatBtn.addEventListener('click', () => this.formatBody());

    this.bodyRawWrap = el('div', { class: 'body-raw' }, [
      this.formatBtn,
      this.bodyEditor.element,
    ]) as HTMLDivElement;

    const gqlFormatBtn = el(
      'button',
      {
        class: 'icon-btn format-btn',
        type: 'button',
        title: 'Format variables',
        'aria-label': 'Format GraphQL variables',
      },
      ['{ }']
    ) as HTMLButtonElement;
    gqlFormatBtn.addEventListener('click', () => {
      const formatted = formatJson(this.gqlVarsEditor.getValue());
      if (formatted === null) {
        gqlFormatBtn.classList.add('shake');
        setTimeout(() => gqlFormatBtn.classList.remove('shake'), 400);
        return;
      }
      this.gqlVarsEditor.setValue(formatted);
      this.request.body.graphqlVariables = formatted;
      this.markDirty();
      this.checkBody();
    });

    this.gqlVarsWrap = el('div', { class: 'gql-vars' }, [
      el('div', { class: 'gql-vars-label' }, ['Variables']),
      this.varsIssue.element,
      el('div', { class: 'gql-vars-editor' }, [
        gqlFormatBtn,
        this.gqlVarsEditor.element,
      ]),
    ]) as HTMLDivElement;

    this.bodyFormTable = new KeyValueTable(
      'Field',
      'Value or file',
      () => {
        this.request.body.form = this.bodyFormTable.getRows();
        this.markDirty();
      },
      true
    );

    this.bodyFormEncodedTable = new KeyValueTable('Field', 'Value', () => {
      this.request.body.form = this.bodyFormEncodedTable.getRows();
      this.markDirty();
    });
    this.bodyFormWrap = el('div', { class: 'body-form' }, [
      this.bodyFormTable.element,
    ]) as HTMLDivElement;

    this.bodyFormEncodedWrap = el('div', { class: 'body-form' }, [
      this.bodyFormEncodedTable.element,
    ]) as HTMLDivElement;

    this.binaryPathLabel = el('span', { class: 'binary-path empty' }, [
      'No file selected',
    ]);

    const chooseBtn = el('button', { class: 'btn btn-ghost' }, [
      'Choose File...',
    ]) as HTMLButtonElement;
    chooseBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'pickFile' });
    });

    const clearBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Clear file',
      'aria-label': 'Clear file',
    }, ['×']) as HTMLButtonElement;
    clearBtn.addEventListener('click', () => {
      this.setBinaryPath('');
      this.markDirty();
    });

    this.bodyBinaryWrap = el('div', { class: 'body-binary' }, [
      el('div', { class: 'binary-row' }, [
        chooseBtn,
        this.binaryPathLabel,
        clearBtn,
      ]),
      el('p', { class: 'binary-hint' }, [
        'The file is streamed as the raw request body. Set Content-Type in the Headers tab if the server needs a specific type.',
      ]),
    ]) as HTMLDivElement;

    return el('div', { class: 'body-panel' }, [
      el('div', { class: 'body-toolbar' }, [this.bodyTypeTabs.element]),
      this.bodyIssue.element,
      this.bodyRawWrap,
      this.gqlVarsWrap,
      this.bodyFormWrap,
      this.bodyFormEncodedWrap,
      this.bodyBinaryWrap,
    ]);
  }

  setBinaryPath(path: string): void {
    this.request.body.binaryPath = path;
    this.binaryPathLabel.textContent = path || 'No file selected';
    this.binaryPathLabel.classList.toggle('empty', !path);
    this.binaryPathLabel.title = path;
  }

  private formatBody(): void {
    const type = this.request.body.type;
    const source = this.bodyEditor.getValue();
    const formatted =
      type === 'xml'
        ? formatXml(source)
        : type === 'graphql'
        ? formatGraphql(source)
        : formatJson(source);

    if (formatted === null) {
      this.formatBtn.classList.add('shake');
      setTimeout(() => this.formatBtn.classList.remove('shake'), 400);
      return;
    }

    this.bodyEditor.setValue(formatted);
    this.request.body.raw = formatted;
    this.markDirty();
    this.checkBody();
  }

  private stashBodyDraft(): void {
    const body = this.request.body;
    const previous = body.type;
    body.drafts ??= {};
    body.formDrafts ??= {};

    if (previous === 'formdata') {
      body.formDrafts[previous] = this.bodyFormTable.getRows();
    } else if (previous === 'formencoded') {
      body.formDrafts[previous] = this.bodyFormEncodedTable.getRows();
    } else if (previous !== 'none' && previous !== 'binary') {
      body.drafts[previous] = this.bodyEditor.getValue();
    }
  }

  private restoreBodyDraft(): void {
    const body = this.request.body;
    const type = body.type;

    if (type === 'formdata') {
      this.bodyFormTable.setRows(body.formDrafts?.[type] ?? body.form ?? []);
      return;
    }

    if (type === 'formencoded') {
      this.bodyFormEncodedTable.setRows(
        body.formDrafts?.[type] ?? body.form ?? []
      );
      return;
    }

    if (type !== 'none' && type !== 'binary') {
      this.bodyEditor.setValue(body.drafts?.[type] ?? '');
    }
  }

  private syncBodyVisibility(): void {
    const type = this.request.body.type;
    const isFormData = type === 'formdata';
    const isFormEncoded = type === 'formencoded';
    const isForm = isFormData || isFormEncoded;
    const isBinary = type === 'binary';
    const isNone = type === 'none';
    const isRaw = !isForm && !isBinary && !isNone;

    this.bodyRawWrap.classList.toggle('hidden', !isRaw);
    this.bodyFormWrap.classList.toggle('hidden', !isFormData);
    this.bodyFormEncodedWrap.classList.toggle('hidden', !isFormEncoded);
    this.bodyBinaryWrap.classList.toggle('hidden', !isBinary);
    this.formatBtn.classList.toggle(
      'hidden',
      type !== 'json' && type !== 'xml' && type !== 'graphql'
    );
    this.formatBtn.title =
      type === 'graphql' ? 'Format query' : 'Format (Shift+Alt+F)';

    this.bodyEditor.setLanguage(LANGUAGE_FOR[type] ?? 'text');
    this.gqlVarsWrap.classList.toggle('hidden', type !== 'graphql');
    this.bodyEditor.setPlaceholder(
      type === 'xml'
        ? '<root>\n  <key>value</key>\n</root>'
        : type === 'graphql'
        ? 'query GetUser($id: ID!) {\n  user(id: $id) {\n    name\n  }\n}'
        : type === 'json'
        ? 'Paste JSON or a JS object — it is converted automatically.'
        : 'Request body'
    );
    this.checkBody();
  }

  private scheduleBodyCheck(): void {
    window.clearTimeout(this.bodyCheckTimer);
    if (this.bodyIssue.visible || this.varsIssue.visible) {
      this.checkBody();
      return;
    }
    this.bodyCheckTimer = window.setTimeout(() => this.checkBody(), 300);
  }

  private checkBody(): void {
    window.clearTimeout(this.bodyCheckTimer);
    if (!this.request) {
      return;
    }
    const type = this.request.body.type;
    const source = this.bodyEditor.getValue();
    const issue =
      type === 'json'
        ? validateJson(source)
        : type === 'xml'
        ? validateXml(source)
        : type === 'graphql'
        ? validateGraphql(source)
        : null;
    this.bodyIssue.show(issue, ISSUE_LABEL[type] ?? '');
    this.varsIssue.show(
      type === 'graphql'
        ? validateJson(this.gqlVarsEditor.getValue(), { objectOnly: true })
        : null,
      'GraphQL variables'
    );
  }

  private buildAuthPanel(): HTMLElement {
    this.authTypeTabs = new Segmented<AuthType>(AUTH_TYPES, 'none', (value) => {
      this.request.auth.type = value;
      this.renderAuthFields();
      this.markDirty();
    });

    this.authFields = el('div', { class: 'auth-fields' }) as HTMLDivElement;

    return el('div', { class: 'auth-panel' }, [
      el('div', { class: 'body-toolbar' }, [this.authTypeTabs.element]),
      this.authFields,
    ]);
  }

  private renderAuthFields(): void {
    clear(this.authFields);
    const auth = this.request.auth;

    if (auth.type === 'bearer') {
      const field = new VarInput('Token', 'field-input token-field', () => {
        auth.bearer = field.getValue();
        this.markDirty();
      });
      field.setValue(auth.bearer ?? '');
      this.authFields.append(this.field('Token', field.element));
    } else if (auth.type === 'basic') {
      auth.basic ??= { username: '', password: '' };
      const username = new VarInput('Username', 'field-input', () => {
        auth.basic!.username = username.getValue();
        this.markDirty();
      });
      username.setValue(auth.basic.username);

      const password = new VarInput('Password', 'field-input', () => {
        auth.basic!.password = password.getValue();
        this.markDirty();
      });
      password.setValue(auth.basic.password);

      this.authFields.append(
        this.field('Username', username.element),
        this.field('Password', password.element)
      );
    }
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    return el('div', { class: 'field-row' }, [
      el('label', { class: 'field-label' }, [label]),
      input,
    ]);
  }

  private buildRequestCookiesPanel(): HTMLElement {
    this.cookieTable = new KeyValueTable('Cookie name', 'Value', () => {
      this.request.cookies = this.cookieTable.getRows();
      this.syncCookieHeader();
      this.markDirty();
    });

    return el('div', { class: 'cookie-panel' }, [
      el('p', { class: 'env-hint' }, [
        'Cookies sent with this request. They are combined into a single Cookie header on send, so HttpOnly cookies work here too.',
      ]),
      this.cookieTable.element,
    ]);
  }

  private syncCookieHeader(): void {
    const cookies = this.cookieTable
      .getRows()
      .filter((c) => !c.isDisabled && c.name.trim());

    const headers = this.headersTable
      .getRows()
      .filter((h) => h.name.toLowerCase() !== 'cookie');

    if (cookies.length > 0) {
      headers.push({
        name: 'Cookie',
        value: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      });
    }

    this.headersTable.setRows(headers);
    this.request.headers = this.headersTable.getRows();
  }

  private buildRawPanel(): HTMLElement {
    this.rawEditor = new CodeEditor('', () => {
      this.rawDirty = true;
      this.syncRawButtons();
    });
    this.rawEditor.setLanguage('text');

    this.rawError = el('div', { class: 'raw-error hidden' }) as HTMLDivElement;

    this.rawApplyButton = el('button', { class: 'btn btn-primary btn-tiny' }, [
      'Apply to request',
    ]) as HTMLButtonElement;
    this.rawApplyButton.addEventListener('click', () => this.applyRaw());

    this.rawRevertButton = el('button', { class: 'btn btn-ghost btn-tiny' }, [
      'Refresh from tabs',
    ]) as HTMLButtonElement;
    this.rawRevertButton.addEventListener('click', () => {
      this.refreshRaw();
      flash(this.rawRevertButton);
    });

    const copyBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy raw request',
      'aria-label': 'Copy raw request',
    }, ['⧉']) as HTMLButtonElement;
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.rawEditor.getValue());
      flash(copyBtn);
      this.flashToast('Raw request copied');
    });

    this.rawFileActions = el('div', {
      class: 'raw-file-actions hidden',
    }) as HTMLDivElement;

    this.rawHexSwitches = el('span', { class: 'hex-switches hidden' });

    return el('div', { class: 'raw-panel' }, [
      el('div', { class: 'body-toolbar' }, [
        this.rawApplyButton,
        this.rawRevertButton,
        copyBtn,
        this.rawHexSwitches,
      ]),
      this.rawFileActions,
      el('p', { class: 'env-hint' }, [
        'The composed HTTP request. Edit it and choose "Apply to request" to update the other tabs. Nothing changes until you apply.',
      ]),
      this.rawError,
      this.rawEditor.element,
    ]);
  }

  private buildSocketPanel(): HTMLElement {
    this.socketStatus = el('span', { class: 'socket-status' }, [
      'Not connected',
    ]);

    this.socketCloseButton = el('button', {
      class: 'btn btn-danger btn-tiny',
      type: 'button',
      title: 'Send a close frame and end the connection',
    }, ['Close socket']) as HTMLButtonElement;
    this.socketCloseButton.addEventListener('click', () => {
      this.socketCloseButton.disabled = true;
      this.socketCloseButton.textContent = 'Closing...';
      vscode.postMessage({ type: 'socketClose' });
    });

    this.socketEventInput = el('input', {
      type: 'text',
      class: 'field-input socket-event-input',
      placeholder: 'Event name, e.g. message',
      spellcheck: 'false',
    }) as HTMLInputElement;
    this.socketEventInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.sendSocketMessage();
      }
    });

    this.socketEventRow = el('div', { class: 'socket-event-row hidden' }, [
      el('label', { class: 'field-label' }, ['Event']),
      this.socketEventInput,
      el('span', { class: 'socket-hint' }, [
        'Leave empty to send the message as a raw frame',
      ]),
    ]);

    this.socketComposer = new CodeEditor('Message to send', () => undefined);
    this.socketComposer.setLanguage('json');
    this.socketComposer.textarea.addEventListener(
      'keydown',
      (event: KeyboardEvent) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.stopPropagation();
          this.sendSocketMessage();
        }
      }
    );

    this.socketSendButton = el('button', {
      class: 'btn btn-primary btn-tiny',
      type: 'button',
    }, ['Send message']) as HTMLButtonElement;
    this.socketSendButton.addEventListener('click', () =>
      this.sendSocketMessage()
    );

    return el('div', { class: 'socket-panel' }, [
      el('div', { class: 'socket-toolbar' }, [
        this.socketStatus,
        this.socketCloseButton,
      ]),
      this.socketEventRow,
      this.socketComposer.element,
      el('div', { class: 'socket-actions' }, [
        this.socketSendButton,
        el('span', { class: 'socket-hint' }, [
          'Ctrl/Cmd+Enter sends the message',
        ]),
      ]),
    ]);
  }

  private sendSocketMessage(): void {
    if (this.socketState !== 'open') {
      this.flashToast('The socket is not open — press Send to connect');
      return;
    }
    const text = this.socketFrameText();
    if (text === null) {
      this.flashToast('Nothing to send — type a message first');
      return;
    }
    vscode.postMessage({ type: 'socketSend', text });
  }

  private socketFrameText(): string | null {
    const message = this.socketComposer.getValue();
    const event = this.socketInfo?.engineIo
      ? this.socketEventInput.value.trim()
      : '';

    if (!event) {
      return message === '' ? null : message;
    }

    const payload = message.trim();
    if (!payload) {
      return `42${JSON.stringify([event])}`;
    }
    try {
      return `42${JSON.stringify([event, JSON.parse(payload) as unknown])}`;
    } catch {
      return `42${JSON.stringify([event, message])}`;
    }
  }

  /** The switches only make sense when there are bytes to reformat. */
  private syncRawHexSwitches(): void {
    if (!this.rawHexSwitches) {
      return;
    }
    const show = this.hasReformattableFiles();
    this.rawHexSwitches.classList.toggle('hidden', !show);
    if (show && this.rawHexSwitches.childElementCount === 0) {
      this.rawHexSwitches.append(
        this.buildHexSwitches(() => this.renderRawWithFiles())
      );
    }
  }

  private syncRawButtons(): void {
    this.rawApplyButton.disabled = !this.rawDirty;
    this.rawApplyButton.textContent = this.rawDirty
      ? 'Apply to request •'
      : 'Apply to request';
  }

  /** Offers a loader for any file too large to inline automatically. */
  private syncFileActions(): void {
    if (!this.rawFileActions) {
      return;
    }

    clear(this.rawFileActions);

    const request = this.request;
    // A truncated preview still needs the loader: the head is shown, but the
    // rest of the file is not.
    const alreadyShown = (name: string): boolean =>
      this.loadedFileBytes.has(name) ||
      Boolean(
        this.lastSentBody?.files?.find(
          (s) =>
            s.name === name &&
            s.preview !== undefined &&
            !s.previewTruncated
        )
      );

    const pending =
      request.body.type === 'binary'
        ? request.body.binaryPath && !alreadyShown('')
          ? [{ name: '', value: request.body.binaryPath }]
          : []
        : (request.body.form ?? []).filter(
            (f) => f.isFile && f.value && !f.isDisabled && !alreadyShown(f.name)
          );

    const show =
      (request.body.type === 'formdata' || request.body.type === 'binary') &&
      pending.length > 0;
    this.rawFileActions.classList.toggle('hidden', !show);
    if (!show) {
      return;
    }

    for (const field of pending) {
      const button = el('button', { class: 'btn btn-ghost btn-tiny' }, [
        `Load full bytes — ${field.value.split('/').pop() ?? field.name}`,
      ]) as HTMLButtonElement;

      button.dataset.field = field.name;
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = 'Reading 0%';
        this.loadedFileBytes.set(field.name, '');
        vscode.postMessage({
          type: 'loadFileBytes',
          field: field.name,
          path: field.value,
        });
      });

      this.rawFileActions.append(button);
    }
  }

  /**
   * Appends a streamed chunk. The Raw text is rebuilt each time so the file
   * contents grow in place, giving visible progress on large files.
   */
  onFileChunk(
    field: string,
    text: string,
    bytesRead: number,
    totalBytes: number
  ): void {
    this.loadedFileBytes.set(
      field,
      (this.loadedFileBytes.get(field) ?? '') + text
    );

    const button = this.rawFileActions?.querySelector<HTMLButtonElement>(
      `[data-field="${cssEscape(field)}"]`
    );
    if (button && totalBytes > 0) {
      const percent = Math.min(100, Math.round((bytesRead / totalBytes) * 100));
      button.textContent = `Reading ${percent}%`;
    }

    this.renderRawWithFiles();
  }

  onFileDone(field: string, note: string): void {
    if (note) {
      this.loadedFileBytes.set(
        field,
        (this.loadedFileBytes.get(field) ?? '') + note
      );
    }
    this.renderRawWithFiles();
    this.syncFileActions();
  }

  onFileBytesError(field: string, message: string): void {
    clear(this.rawFileActions);
    this.rawFileActions.classList.remove('hidden');
    this.rawFileActions.append(
      el('div', { class: 'raw-error-line' }, [`${field}: ${message}`])
    );
  }

  /** Re-renders the Raw text, folding in any loaded file contents. */
  private renderRawWithFiles(): void {
    if (!this.rawEditor) {
      return;
    }
    this.rawEditor.setValue(toRawHttp(this.collect(), this.mergedBodyInfo()));
  }

  private mergedBodyInfo(): SentBodyInfo | undefined {
    const merged =
      this.loadedFileBytes.size > 0
        ? {
            ...(this.lastSentBody ?? { totalBytes: 0 }),
            files: [
              ...[...this.loadedFileBytes].map(
                ([name, preview]): SentFileInfo => ({
                  name,
                  fileName: name,
                  bytes: preview.length,
                  preview,
                })
              ),
              ...(this.lastSentBody?.files ?? []),
            ].filter(
              (f, i, all) => all.findIndex((x) => x.name === f.name) === i
            ),
          }
        : this.lastSentBody;

    if (!merged?.files?.length) {
      return merged;
    }

    // The host renders each preview with offsets; re-format it here so the
    // switches take effect without re-sending the request.
    return {
      ...merged,
      files: merged.files.map((file) =>
        file.previewBase64 === undefined
          ? file
          : {
              ...file,
              preview: renderHead(file.previewBase64, file.previewNote ?? '', {
                hex: this.hexView,
                offsets: this.hexOffsets,
              }),
            }
      ),
    };
  }

  /** True once a file part carries bytes the hex switches can reformat. */
  private hasReformattableFiles(): boolean {
    return Boolean(
      this.mergedBodyInfo()?.files?.some((f) => f.previewBase64 !== undefined)
    );
  }

  /** Re-renders the Raw tab from the current field values. */
  private refreshRaw(): void {
    if (!this.rawEditor) {
      return;
    }

    this.renderRawWithFiles();
    this.syncFileActions();
    this.syncRawHexSwitches();
    this.rawDirty = false;
    this.rawError.classList.add('hidden');
    this.syncRawButtons();
  }

  private applyRaw(): void {
    const parsed = fromRawHttp(this.rawEditor.getValue());

    if (!parsed.ok || !parsed.request) {
      clear(this.rawError);
      this.rawError.classList.remove('hidden');
      this.rawError.append(
        el('strong', {}, ['Could not apply this request']),
        ...parsed.errors.map((message) =>
          el('div', { class: 'raw-error-line' }, [message])
        )
      );
      return;
    }

    const next = parsed.request;
    this.rawError.classList.add('hidden');

    if (next.method) {
      this.request.method = next.method;
      this.methodDropdown.setValue(next.method);
    }
    if (next.url !== undefined) {
      this.request.url = next.url;
      this.urlField.setValue(next.url);
    }
    if (next.params) {
      this.request.params = next.params;
      this.paramsTable.setRows(next.params);
    }
    if (next.headers) {
      this.request.headers = next.headers;
      this.headersTable.setRows(next.headers);
    }
    if (next.cookies) {
      this.request.cookies = next.cookies;
      this.cookieTable.setRows(next.cookies);
    }
    if (next.auth) {
      this.request.auth = next.auth;
      this.authTypeTabs.setValue(next.auth.type);
      this.renderAuthFields();
    }
    if (next.body) {
      this.request.body = { ...this.request.body, ...next.body };
      this.bodyTypeTabs.setValue(this.request.body.type);
      this.restoreBodyDraftFrom(this.request.body);
      this.syncBodyVisibility();
    }

    this.syncBodyTabVisibility();
    this.rawDirty = false;
    this.syncRawButtons();
    this.markDirty();
    flash(this.rawApplyButton);
  }

  private restoreBodyDraftFrom(body: ApiRequest['body']): void {
    if (body.type === 'formdata') {
      this.bodyFormTable.setRows(body.form ?? []);
    } else if (body.type === 'formencoded') {
      this.bodyFormEncodedTable.setRows(body.form ?? []);
    } else if (body.type !== 'none' && body.type !== 'binary') {
      this.bodyEditor.setValue(body.raw ?? '');
    }
    this.setBinaryPath(body.binaryPath ?? '');
  }

  private buildResponse(): HTMLElement {
    this.responseArea = el('div', { class: 'response-section' }) as HTMLDivElement;
    this.showResponsePlaceholder('Send a request to see the response.');
    return this.responseArea;
  }

  private showResponsePlaceholder(text: string): void {
    clear(this.responseArea);
    this.responseArea.append(
      el('div', { class: 'response-placeholder' }, [text])
    );
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.syncSaveButton();
      vscode.postMessage({ type: 'dirty', dirty: true });
    }
    this.refreshRawIfVisible();
  }

  /** Recomposes Raw when it is on screen and holds no unapplied edits. */
  private refreshRawIfVisible(): void {
    if (this.rawDirty || !this.rawEditor) {
      return;
    }
    if (this.tabPanels.get('raw')?.classList.contains('active')) {
      this.refreshRaw();
    }
  }

  private syncSaveButton(): void {
    this.toCollectionButton.classList.toggle('hidden', this.saved);
    this.saveButton.classList.remove('hidden');
    this.saveButton.textContent = this.dirty ? 'Save •' : 'Saved';
    this.saveButton.disabled = !this.dirty;
    this.nameInput.classList.toggle('dirty', this.dirty);
  }

  private save(): void {
    if (!this.dirty) {
      return;
    }
    vscode.postMessage({ type: 'save', request: this.collect() });
  }

  onSaved(request: ApiRequest): void {
    this.request = request;
    this.saved = true;
    this.dirty = false;
    this.syncSaveButton();
    vscode.postMessage({ type: 'dirty', dirty: false });
  }

  /** Saved into Activity: clears the dirty marker but stays uncollected. */
  onActivitySaved(request: ApiRequest): void {
    this.request = request;
    this.dirty = false;
    this.syncSaveButton();
    vscode.postMessage({ type: 'dirty', dirty: false });
  }

  private static readonly DEFAULT_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  private seedDefaultHeaders(request: ApiRequest): void {
    request.headers ??= [];
    const hasUA = request.headers.some(
      (h) => h.name.toLowerCase() === 'user-agent'
    );
    if (!hasUA) {
      request.headers.push({
        name: 'User-Agent',
        value: RequestView.DEFAULT_UA,
      });
    }
  }

  setRequest(request: ApiRequest, saved: boolean): void {
    this.seedDefaultHeaders(request);
    this.request = request;
    this.saved = saved;
    this.dirty = false;
    this.nameInput.value = request.name;
    this.methodDropdown.setValue(request.method);
    this.syncBodyTabVisibility();
    this.urlField.setValue(request.url);
    this.paramsTable.setRows(request.params);
    this.headersTable.setRows(request.headers);
    this.cookieTable.setRows(request.cookies ?? []);
    this.bodyTypeTabs.setValue(request.body.type);
    request.body.drafts ??= {};
    request.body.formDrafts ??= {};
    if (request.body.raw && !request.body.drafts[request.body.type]) {
      request.body.drafts[request.body.type] = request.body.raw;
    }
    if (
      request.body.form?.length &&
      !request.body.formDrafts[request.body.type]
    ) {
      request.body.formDrafts[request.body.type] = request.body.form;
    }
    this.restoreBodyDraft();
    this.setBinaryPath(request.body.binaryPath ?? '');
    this.gqlVarsEditor.setValue(request.body.graphqlVariables ?? '');
    this.authTypeTabs.setValue(request.auth.type);
    this.syncBodyVisibility();
    this.renderAuthFields();
    this.syncSaveButton();
    this.applyMethodDefaultTab();
  }

  private collect(): ApiRequest {
    this.request.name = this.nameInput.value || 'New Request';
    this.request.url = this.urlField.getValue();
    this.request.method = this.methodDropdown.getValue();
    this.request.params = this.paramsTable.getRows();
    this.request.headers = this.headersTable.getRows();
    this.request.cookies = this.cookieTable.getRows();
    this.request.body.type = this.bodyTypeTabs.getValue();
    this.stashBodyDraft();
    const activeType = this.request.body.type;
    this.request.body.raw =
      activeType === 'formencoded' || activeType === 'formdata'
        ? ''
        : this.bodyEditor.getValue();
    this.request.body.form =
      activeType === 'formdata'
        ? this.bodyFormTable.getRows()
        : activeType === 'formencoded'
        ? this.bodyFormEncodedTable.getRows()
        : this.request.body.form ?? [];
    this.request.body.graphqlVariables = this.gqlVarsEditor.getValue();
    this.request.auth.type = this.authTypeTabs.getValue();
    this.request.modified = new Date().toISOString();
    return this.request;
  }

  private send(): void {
    if (!this.urlField.getValue().trim()) {
      this.showResponsePlaceholder('Enter a URL first.');
      return;
    }
    const request = this.collect();
    // The previous capture no longer describes this request.
    this.lastSentBody = undefined;
    this.loadedFileBytes.clear();
    if (!this.rawDirty) {
      this.refreshRaw();
    }
    if (this.socketInfo) {
      this.socketState = 'connecting';
      this.syncSocketControls();
    }
    vscode.postMessage({ type: 'send', request });
  }

  requestSave(): void {
    this.save();
  }

  requestSend(): void {
    this.send();
  }

  openResponseFind(): void {
    this.responseFind?.open();
  }

  isSaved(): boolean {
    return this.saved;
  }

  setFollowRedirects(value: boolean): void {
    this.followRedirects = value;
    this.followSwitch?.classList.toggle('on', value);
    this.followSwitch?.setAttribute('aria-checked', String(value));
  }

  repaintAll(): void {
    this.urlField.repaint();
    this.paramsTable.repaint();
    this.headersTable.repaint();
    this.bodyFormTable.repaint();
    this.bodyEditor.repaint();
    this.gqlVarsEditor.repaint();
    this.socketComposer.repaint();
    this.renderAuthFields();
  }

  markImported(): void {
    this.markDirty();
    this.flashToast('Imported from cURL');
  }

  onCurlBuilt(curl: string): void {
    void navigator.clipboard.writeText(curl);
    this.flashToast('cURL copied to clipboard');
  }

  private toastTimers: number[] = [];

  /** Shows a transient message, replacing any toast still on screen. */
  flashToast(text: string): void {
    for (const timer of this.toastTimers) {
      clearTimeout(timer);
    }
    this.toastTimers = [];
    document.querySelector('.toast')?.remove();

    const toast = el('div', { class: 'toast' }, [text]);
    document.body.append(toast);
    this.toastTimers.push(
      window.setTimeout(() => toast.classList.add('fade'), 1600),
      window.setTimeout(() => toast.remove(), 2200)
    );
  }

  onFilePicked(path: string): void {
    this.setBinaryPath(path);
    this.markDirty();
  }

  setSending(hasUpload = false): void {
    this.sendButton.disabled = true;
    this.sendButton.textContent = 'Sending';

    clear(this.responseArea);

    const abort = el('button', { class: 'btn btn-ghost' }, [
      'Cancel request',
    ]) as HTMLButtonElement;
    abort.addEventListener('click', () => {
      vscode.postMessage({ type: 'abort' });
      abort.disabled = true;
      abort.textContent = 'Cancelling...';
    });

    this.uploadBar = hasUpload
      ? (el('div', { class: 'upload-bar' }, [
          el('div', { class: 'upload-fill' }),
        ]) as HTMLDivElement)
      : null;

    this.uploadLabel = hasUpload
      ? (el('div', { class: 'upload-label' }, ['Uploading 0%']) as HTMLDivElement)
      : null;

    this.responseArea.append(
      el('div', { class: 'sending-state' }, [
        el('div', { class: 'spinner' }),
        el('div', { class: 'sending-label' }, ['Sending request...']),
        ...(this.uploadBar ? [this.uploadBar, this.uploadLabel!] : []),
        abort,
      ])
    );
  }

  private streamBody: HTMLElement | null = null;
  private streamMeta: HTMLElement | null = null;
  private streamText = '';
  private streamEvents = 0;

  /**
   * Replaces the loader with a live view as soon as the first bytes arrive,
   * keeping a small spinner until the stream closes.
   */
  onStreamStart(info: { status: number; statusText: string }): void {
    this.streamText = '';
    this.streamEvents = 0;

    clear(this.responseArea);

    const statusClass =
      info.status >= 500
        ? 'status-server-error'
        : info.status >= 400
        ? 'status-client-error'
        : info.status >= 300
        ? 'status-redirect'
        : 'status-ok';

    const abort = el('button', {
      class: 'btn btn-ghost btn-compact stream-cancel',
      type: 'button',
    }, ['Cancel request']) as HTMLButtonElement;
    abort.addEventListener('click', () => {
      vscode.postMessage({ type: 'abort' });
      abort.disabled = true;
      abort.textContent = 'Cancelling...';
    });

    this.streamMeta = el('span', { class: 'stream-count' }, ['waiting...']);

    const body = el('pre', { class: 'stream-body' });
    this.streamBody = body;

    this.responseArea.append(
      el('div', { class: 'response-content stream-view' }, [
        el('div', { class: 'status-bar' }, [
          el('span', {
            class: `status-pill ${statusClass}`,
          }, [`${info.status} ${info.statusText}`.trim()]),
          el('span', { class: 'stream-live' }, [
            el('span', { class: 'spinner spinner-sm' }),
            'Streaming',
          ]),
          this.streamMeta,
          abort,
        ]),
        body,
      ])
    );
  }

  /** Appends a chunk and keeps the view pinned to the newest data. */
  onStreamChunk(text: string, totalBytes: number): void {
    if (!this.streamBody) {
      return;
    }

    this.streamText += text;
    this.streamEvents += (text.match(/\n\n/g) ?? []).length;

    const atBottom =
      this.streamBody.scrollHeight -
        this.streamBody.scrollTop -
        this.streamBody.clientHeight <
      40;

    const line = el('span', { class: 'stream-chunk' }, [text]);
    this.streamBody.append(line);

    requestAnimationFrame(() => line.classList.add('settled'));

    if (this.streamMeta) {
      this.streamMeta.textContent =
        `${this.streamEvents} event${this.streamEvents === 1 ? '' : 's'} · ` +
        formatBytes(totalBytes);
    }

    if (atBottom) {
      this.streamBody.scrollTop = this.streamBody.scrollHeight;
    }
  }

  /** Records what the engine actually built so Raw can show real values. */
  onSentBody(info: SentBodyInfo): void {
    this.lastSentBody = info;
    this.refreshRawIfVisible();
  }

  setUploadProgress(sent: number, total: number): void {
    if (!this.uploadBar || !this.uploadLabel) {
      return;
    }
    const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
    const fill = this.uploadBar.querySelector<HTMLElement>('.upload-fill');
    if (fill) {
      fill.style.width = `${percent}%`;
    }
    this.uploadLabel.textContent = `Uploading ${percent}% — ${formatBytes(
      sent
    )} of ${formatBytes(total)}`;
  }

  setResult(
    result: SendResult,
    missing: string[] = [],
    sentUrl = '',
    binaryTextLimit = 2 * 1024 * 1024,
    rawHexView = true,
    rawHexOffsets = true
  ): void {
    this.binaryTextLimit = binaryTextLimit;
    this.hexView = rawHexView;
    this.hexOffsets = rawHexOffsets;
    this.showBinaryAsText = false;
    // Any completed result clears an in-progress download view.
    this.downloadBar = null;
    this.downloadLabel = null;
    this.lastResponse = result.ok ? result.response : null;
    this.socketInfo = result.ok ? result.response.webSocket ?? null : null;
    this.socketState = this.socketInfo ? 'open' : 'none';
    this.socketLastClose = null;
    this.socketLog = null;
    this.socketTabButton = null;
    this.socketBadge = null;
    this.socketMessages = 0;
    this.sendButton.disabled = false;
    this.sendButton.textContent = 'Send';

    clear(this.responseArea);

    if (missing.length > 0) {
      this.responseArea.append(
        el('div', { class: 'var-warning' }, [
          el('strong', {}, ['Unresolved variables: ']),
          missing.map((m) => `{{${m}}}`).join(', '),
        ])
      );
    }

    if (sentUrl && sentUrl !== this.urlField.getValue()) {
      this.responseArea.append(
        el('div', { class: 'resolved-url' }, [
          el('span', { class: 'resolved-label' }, ['Sent to ']),
          sentUrl,
        ])
      );
    }

    if (!result.ok) {
      this.responseArea.append(
        el('div', { class: 'response-error' }, [
          el('strong', {}, ['Request failed']),
          el('div', { class: 'error-message' }, [result.error.message]),
        ])
      );
      this.settleSocketTabs();
      return;
    }

    this.responseArea.append(
      this.buildStatusBar(result.response),
      this.buildResponseBody(result.response)
    );
    this.settleSocketTabs();
  }

  private followRedirects = true;
  private followSwitch: HTMLElement | null = null;

  private buildFollowSwitch(): HTMLElement {
    const track = el('span', { class: 'resp-switch-track' });
    const control = el('span', {
      class: `resp-switch${this.followRedirects ? ' on' : ''}`,
      role: 'switch',
      tabindex: '0',
      title:
        'When on, 3xx responses are followed automatically and the chain is listed in the Redirects tab',
      'aria-checked': String(this.followRedirects),
      'aria-label': 'Follow redirects',
    }, [track, 'Follow Redirects']);

    const flip = (): void => {
      this.followRedirects = !this.followRedirects;
      control.classList.toggle('on', this.followRedirects);
      control.setAttribute('aria-checked', String(this.followRedirects));
      vscode.postMessage({
        type: 'setFollowRedirects',
        value: this.followRedirects,
      });
    };

    this.followSwitch = control;
    control.addEventListener('click', flip);
    control.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        flip();
      }
    });

    return control;
  }

  private buildRedirectsPanel(response: ApiResponse): HTMLElement {
    const hops = response.hops ?? [];

    if (hops.length === 0) {
      const reason = this.followRedirects
        ? 'This request completed without any redirects.'
        : 'Follow Redirects is off, so 3xx responses are returned as-is.';
      return el('div', { class: 'tab-panel' }, [
        el('div', { class: 'redirect-empty' }, [reason]),
      ]);
    }

    const chain = el('div', { class: 'redirect-chain' });

    const row = (
      opts: {
        status: number;
        statusText: string;
        method: string;
        url: string;
        durationMs?: number;
        note?: string;
        cookies?: string[];
        final?: boolean;
      }
    ): HTMLElement => {
      const line = el('div', { class: 'redirect-line' }, [
        el('span', { class: 'redirect-status' }, [
          `${opts.status} ${opts.statusText}`.trim(),
        ]),
        el('span', { class: 'redirect-method' }, [opts.method]),
      ]);

      if (opts.durationMs !== undefined) {
        line.append(
          el('span', { class: 'redirect-time' }, [`${opts.durationMs} ms`])
        );
      }

      const body = el('div', { class: 'redirect-body' }, [
        line,
        el('div', { class: 'redirect-url' }, [opts.url]),
      ]);

      if (opts.note) {
        body.append(el('div', { class: 'redirect-note' }, [opts.note]));
      }

      for (const cookie of opts.cookies ?? []) {
        body.append(
          el('div', { class: 'redirect-note' }, [`Set-Cookie: ${cookie}`])
        );
      }

      return el('div', {
        class: `redirect-hop${opts.final ? ' final' : ''}`,
      }, [
        el('div', { class: 'redirect-rail' }, [
          el('span', { class: 'redirect-dot' }),
        ]),
        body,
      ]);
    };

    for (const hop of hops) {
      chain.append(
        row({
          status: hop.status,
          statusText: hop.statusText,
          method: hop.method,
          url: hop.from,
          durationMs: hop.durationMs,
          note:
            hop.nextMethod !== hop.method
              ? `Method changed to ${hop.nextMethod} and the body was dropped`
              : undefined,
          cookies: hop.setCookie,
        })
      );
    }

    chain.append(
      row({
        status: response.status,
        statusText: response.statusText,
        method: hops[hops.length - 1].nextMethod,
        url: hops[hops.length - 1].to,
        final: true,
      })
    );

    const label = `${hops.length} redirect${hops.length === 1 ? '' : 's'}`;
    const copy = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy redirect chain',
      'aria-label': 'Copy redirect chain',
    }, ['⧉']) as HTMLButtonElement;

    const asText = [
      ...hops.map(
        (h) => `${h.status} ${h.statusText}  ${h.method} ${h.from}  →  ${h.to}`
      ),
      `${response.status} ${response.statusText}  ${hops[hops.length - 1].to}`,
    ].join('\n');

    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(asText);
      flash(copy);
      this.flashToast('Redirect chain copied');
    });

    return el('div', { class: 'tab-panel' }, [
      el('div', { class: 'response-toolbar' }, [
        el('span', { class: 'response-lang' }, [label]),
        copy,
      ]),
      chain,
    ]);
  }

  private buildStatusBar(response: ApiResponse): HTMLElement {
    const statusClass =
      response.status >= 500
        ? 'status-server-error'
        : response.status >= 400
        ? 'status-client-error'
        : response.status >= 300
        ? 'status-redirect'
        : 'status-ok';

    return el('div', { class: 'status-bar' }, [
      el('span', { class: `status-pill ${statusClass}` }, [
        `${response.status} ${response.statusText}`.trim(),
      ]),
      el('span', { class: 'status-meta' }, [`${response.timing.total} ms`]),
      el('span', { class: 'status-meta' }, [formatBytes(response.bodyBytes)]),
      response.truncated
        ? el('span', { class: 'status-warn' }, ['truncated'])
        : el('span', {}),
      this.socketBadgeFor(response),
    ]);
  }

  private buildResponseBody(response: ApiResponse): HTMLElement {
    const language = languageForContentType(response.contentType);
    const pretty = formatIfJson(response.body, response.contentType);

    const folded = new FoldedView();
    folded.setContent(pretty, language);
    const bodyPre = el('pre', { class: 'response-body' }, [folded.element]);

    const copyBody = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy response body',
      'aria-label': 'Copy response body',
    }, ['⧉']) as HTMLButtonElement;
    copyBody.addEventListener('click', () => {
      void navigator.clipboard.writeText(pretty);
      flash(copyBody);
      this.flashToast('Response body copied');
    });

    const foldToggle = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Collapse all sections',
      'aria-label': 'Collapse all sections',
    }, ['⊟']) as HTMLButtonElement;

    let allCollapsed = false;
    foldToggle.addEventListener('click', () => {
      allCollapsed = !allCollapsed;
      if (allCollapsed) {
        folded.collapseAll();
        foldToggle.textContent = '⊞';
        foldToggle.title = 'Expand all sections';
      } else {
        folded.expandAll();
        foldToggle.textContent = '⊟';
        foldToggle.title = 'Collapse all sections';
      }
    });
    foldToggle.classList.toggle('hidden', !folded.foldable);

    const findBar = new FindBar(
      (state) => {
        const { total, invalid } = folded.search(state);
        findBar.setStatus(folded.currentMatch, total, invalid);
      },
      (delta) => {
        const index = folded.step(delta);
        findBar.setStatus(index, folded.matchCount, false);
      },
      () => findBar.close()
    );
    this.responseFind = findBar;

    const findButton = el('button', {
      class: 'icon-btn find-icon-btn',
      type: 'button',
      title: 'Find in response (Ctrl/Cmd+F)',
      'aria-label': 'Find in response',
    }, ['⌕']) as HTMLButtonElement;
    findButton.addEventListener('click', () => findBar.open());

    const bodyPanel = el('div', { class: 'tab-panel active' }, [
      el('div', { class: 'response-toolbar' }, [
        el('span', { class: 'response-lang' }, [language]),
        findButton,
        foldToggle,
        copyBody,
      ]),
      findBar.element,
      bodyPre,
    ]);

    const headersPanel = this.buildHeadersPanelFor(response);
    const cookies = response.headers
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => parseSetCookie(h.value))
      .filter((c): c is Cookie => c !== null);
    const cookiesPanel = this.buildCookiesPanel(cookies);

    const hopCount = response.hops?.length ?? 0;

    // A binary payload replaces the body panel only; the other tabs still
    // describe the response and must stay reachable.
    const primaryPanel = this.downloading
      ? this.buildDownloadingPanel()
      : this.savedFile
      ? this.buildSavedFilePanel()
      : response.webSocket
      ? this.buildSocketNotePanel()
      : response.binary && !this.showBinaryAsText
      ? this.buildBinaryChoicePanel(response)
      : bodyPanel;

    const panels = new Map<string, HTMLElement>([
      ['body', primaryPanel],
      ['headers', headersPanel],
      ['cookies', cookiesPanel],
    ]);

    const tabs: [string, string][] = [
      ['body', 'Response'],
      ['headers', `Headers (${response.headers.length})`],
      ['cookies', `Cookies (${cookies.length})`],
    ];

    if (this.followRedirects) {
      panels.set('redirects', this.buildRedirectsPanel(response));
      tabs.push(['redirects', `Redirects (${hopCount})`]);
    }

    panels.set('raw', this.buildRawResponsePanel(response));
    tabs.push(['raw', 'Raw']);

    if (response.webSocket) {
      panels.set('socket', this.buildSocketLogPanel(response.webSocket));
      tabs.push(['socket', 'Socket (0)']);
    }

    const bar = el('div', { class: 'tab-bar' });
    const buttons = new Map<string, HTMLButtonElement>();

    for (const [id, label] of tabs) {
      const button = el('button', { class: 'tab-btn' }, [
        label,
      ]) as HTMLButtonElement;
      button.addEventListener('click', () => {
        for (const [key, panel] of panels) {
          panel.classList.toggle('active', key === id);
        }
        for (const [key, b] of buttons) {
          b.classList.toggle('active', key === id);
        }
      });
      buttons.set(id, button);
      bar.append(button);
    }

    const initial = response.webSocket ? 'socket' : 'body';
    for (const [key, panel] of panels) {
      panel.classList.toggle('active', key === initial);
    }
    buttons.get(initial)?.classList.add('active');
    this.socketTabButton = buttons.get('socket') ?? null;

    return el('div', { class: 'response-content' }, [
      bar,
      el('div', { class: 'tab-panels' }, [...panels.values()]),
    ]);
  }

  /** The response exactly as it came off the wire: status line, headers, body. */
  private showBinaryAsText = false;
  private binaryTextLimit = 2 * 1024 * 1024;
  private hexView = true;
  private hexOffsets = true;
  private downloadBar: HTMLDivElement | null = null;
  private downloadLabel: HTMLDivElement | null = null;

  /** Replaces the choice panel with live progress while bytes stream to disk. */
  private lastResponse: ApiResponse | null = null;

  /** The progress view, built once and then only updated, so the tab bar and
   *  the selected tab survive every progress tick. */
  private buildDownloadingPanel(): HTMLElement {
    this.downloadBar = el('div', { class: 'upload-bar' }, [
      el('div', { class: 'upload-fill' }),
    ]) as HTMLDivElement;
    this.downloadLabel = el('div', { class: 'upload-label' }, [
      'Downloading...',
    ]) as HTMLDivElement;

    const abort = el('button', {
      class: 'btn btn-ghost btn-compact',
      type: 'button',
    }, ['Cancel download']) as HTMLButtonElement;
    abort.addEventListener('click', () => {
      vscode.postMessage({ type: 'abort' });
      abort.disabled = true;
      abort.textContent = 'Cancelling...';
    });

    return el('div', { class: 'tab-panel active binary-choice' }, [
      el('div', { class: 'sending-state' }, [
        this.downloadBar,
        this.downloadLabel,
        abort,
      ]),
    ]);
  }

  onDownloadProgress(received: number, total: number): void {
    if (!this.downloadBar) {
      // Rebuild the whole response view once, with the progress panel as the
      // body, so headers, cookies and redirects stay reachable while the file
      // downloads. Later ticks only touch the bar and the label.
      this.downloading = true;
      clear(this.responseArea);
      if (this.lastResponse) {
        // buildResponseBody picks the progress panel while `downloading` is
        // set, and wraps it in the usual tab container.
        this.responseArea.append(
          this.buildStatusBar(this.lastResponse),
          this.buildResponseBody(this.lastResponse)
        );
      } else {
        this.responseArea.append(this.buildDownloadingPanel());
      }
      this.downloading = false;
    }

    if (!this.downloadBar) {
      return;
    }

    const fill = this.downloadBar.querySelector<HTMLElement>('.upload-fill');
    if (total > 0) {
      const percent = Math.round((received / total) * 100);
      if (fill) {
        fill.style.width = `${percent}%`;
      }
      if (this.downloadLabel) {
        this.downloadLabel.textContent =
          `Downloading ${percent}% — ${formatBytes(received)} of ${formatBytes(total)}`;
      }
      return;
    }

    if (this.downloadLabel) {
      this.downloadLabel.textContent = `Downloading — ${formatBytes(received)}`;
    }
  }

  onDownloadDone(
    path: string,
    bytes: number,
    result: SendResult,
    sentUrl: string,
    binaryTextLimit?: number
  ): void {
    this.downloadBar = null;
    this.downloadLabel = null;
    this.savedFile = { path, bytes };
    this.setResult(result, [], sentUrl, binaryTextLimit);
    this.savedFile = null;
    this.flashToast('Download complete');
  }

  /** Set while rendering a response whose body went straight to disk. */
  private savedFile: { path: string; bytes: number } | null = null;
  private downloading = false;

  private buildSavedFilePanel(): HTMLElement {
    const saved = this.savedFile;
    const reveal = el('button', {
      class: 'btn btn-ghost btn-compact',
      type: 'button',
    }, ['Show in folder']) as HTMLButtonElement;
    reveal.addEventListener('click', () => {
      vscode.postMessage({ type: 'revealFile', path: saved?.path ?? '' });
    });

    return el('div', { class: 'tab-panel active binary-choice' }, [
      el('div', { class: 'binary-note' }, [
        el('strong', {}, [`Saved ${formatBytes(saved?.bytes ?? 0)}`]),
        el('p', { class: 'saved-path' }, [saved?.path ?? '']),
        el('div', { class: 'binary-actions' }, [reveal]),
      ]),
    ]);
  }

  /**
   * Binary payloads are offered as a download by default; rendering the bytes
   * as text is opt-in, since it is only useful for inspection.
   */
  private buildBinaryChoicePanel(response: ApiResponse): HTMLElement {
    const size = response.bodyBytes > 0 ? formatBytes(response.bodyBytes) : 'unknown size';
    const type = response.contentType.split(';')[0].trim() || 'binary data';

    const download = el('button', {
      class: 'btn btn-primary',
      type: 'button',
    }, ['Download file']) as HTMLButtonElement;
    download.addEventListener('click', () => {
      vscode.postMessage({
        type: 'resendBinary',
        mode: 'download',
        request: this.collect(),
      });
    });

    // Rendering a very large binary payload as text is slow and rarely
    // useful, so above the configured limit only the download is offered.
    const textAllowed =
      this.binaryTextLimit > 0 && response.bodyBytes <= this.binaryTextLimit;

    const asText = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
    }, ['Show as text']) as HTMLButtonElement;
    asText.addEventListener('click', () => {
      this.showBinaryAsText = true;
      vscode.postMessage({
        type: 'resendBinary',
        mode: 'text',
        request: this.collect(),
      });
    });

    return el('div', { class: 'tab-panel active binary-choice' }, [
      el('div', { class: 'binary-note' }, [
        el('strong', {}, [`${type} — ${size}`]),
        el('p', {}, [
          response.probed
            ? 'This response is binary. Nothing has been transferred yet — ' +
              'choose to download the file, or fetch it and show the bytes as text.'
            : 'This response is binary, so it is not shown as text. Download ' +
              'it to get the exact bytes, or display them for inspection.',
        ]),
        el('div', { class: 'binary-actions' }, [
          download,
          ...(textAllowed ? [asText] : []),
        ]),
        ...(textAllowed
          ? []
          : [
              el('p', { class: 'binary-limit-note' }, [
                `Too large to show as text (limit ${formatBytes(
                  this.binaryTextLimit
                )}). Change telegraph.binaryTextLimit to adjust.`,
              ]),
            ]),
      ]),
    ]);
  }

  /**
   * The hex switches. `onChange` re-renders whichever view owns them; the
   * choice is persisted so it survives reloads.
   */
  private buildHexSwitches(onChange: () => void): HTMLElement {
    const offsetsSwitch = el('span', {
      class: `resp-switch hex-switch${this.hexOffsets ? ' on' : ''}`,
      role: 'switch',
      tabindex: '0',
      title: 'Show the offset column and ASCII gutter',
      'aria-checked': String(this.hexOffsets),
      'aria-label': 'Offsets and ASCII',
    }, [el('span', { class: 'resp-switch-track' }), 'Offsets & ASCII']);

    const syncOffsets = (): void => {
      offsetsSwitch.classList.toggle('disabled', !this.hexView);
      offsetsSwitch.setAttribute('aria-disabled', String(!this.hexView));
    };

    const hexSwitch = el('span', {
      class: `resp-switch hex-switch${this.hexView ? ' on' : ''}`,
      role: 'switch',
      tabindex: '0',
      title: 'Show the bytes as a hex dump instead of decoded text',
      'aria-checked': String(this.hexView),
      'aria-label': 'Hex view',
    }, [el('span', { class: 'resp-switch-track' }), 'Hex view']);

    const persist = (): void => {
      vscode.postMessage({
        type: 'setHexView',
        hex: this.hexView,
        offsets: this.hexOffsets,
      });
    };

    const flipHex = (): void => {
      this.hexView = !this.hexView;
      hexSwitch.classList.toggle('on', this.hexView);
      hexSwitch.setAttribute('aria-checked', String(this.hexView));
      syncOffsets();
      persist();
      onChange();
    };

    const flipOffsets = (): void => {
      if (!this.hexView) {
        return;
      }
      this.hexOffsets = !this.hexOffsets;
      offsetsSwitch.classList.toggle('on', this.hexOffsets);
      offsetsSwitch.setAttribute('aria-checked', String(this.hexOffsets));
      persist();
      onChange();
    };

    for (const [control, flip] of [
      [hexSwitch, flipHex],
      [offsetsSwitch, flipOffsets],
    ] as [HTMLElement, () => void][]) {
      control.addEventListener('click', flip);
      control.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          flip();
        }
      });
    }

    syncOffsets();
    return el('span', { class: 'hex-switches' }, [hexSwitch, offsetsSwitch]);
  }

  private buildRawResponsePanel(response: ApiResponse): HTMLElement {
    const head =
      `HTTP/1.1 ${response.status} ${response.statusText}`.trim() +
      '\n' +
      response.headers.map((h) => `${h.name}: ${h.value}`).join('\n');

    // A binary body is reformatted in the webview from the base64 head, so the
    // switches never need another request.
    const canSwitch = typeof response.headBase64 === 'string';

    const compose = (): string => {
      if (!canSwitch) {
        return toRawHttpResponse(response);
      }
      const body = renderHead(response.headBase64 ?? '', response.headNote ?? '', {
        hex: this.hexView,
        offsets: this.hexOffsets,
      });
      return body ? `${head}\n\n${body}` : head;
    };

    const pre = el('pre', { class: 'response-body' }, [compose()]);

    const copyRaw = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy raw response',
      'aria-label': 'Copy raw response',
    }, ['\u29c9']) as HTMLButtonElement;
    copyRaw.addEventListener('click', () => {
      void navigator.clipboard.writeText(pre.textContent ?? '');
      flash(copyRaw);
      this.flashToast('Raw response copied');
    });

    const toolbar = el('div', { class: 'response-toolbar' }, [
      el('span', { class: 'response-lang' }, ['HTTP']),
      copyRaw,
    ]);

    if (canSwitch) {
      toolbar.append(
        this.buildHexSwitches(() => {
          pre.textContent = compose();
        })
      );
    }

    return el('div', { class: 'tab-panel' }, [toolbar, pre]);
  }

  private buildSocketNotePanel(): HTMLElement {
    return el('div', { class: 'tab-panel' }, [
      el('div', { class: 'response-placeholder' }, [
        '101 Switching Protocols carries no body. The connection is now a WebSocket, and its messages are in the Socket tab.',
      ]),
    ]);
  }

  private socketBadgeFor(response: ApiResponse): HTMLElement {
    if (!response.webSocket) {
      return el('span', {});
    }
    this.socketBadge = el('span', { class: 'socket-badge open' }, [
      'WebSocket open',
    ]);
    return this.socketBadge;
  }

  private buildSocketLogPanel(info: WebSocketInfo): HTMLElement {
    const log = el('div', { class: 'socket-log' });
    this.socketLog = log;

    const clearButton = el('button', {
      class: 'btn btn-ghost btn-tiny',
      type: 'button',
    }, ['Clear']) as HTMLButtonElement;
    clearButton.addEventListener('click', () => {
      clear(log);
      this.socketMessages = 0;
      this.syncSocketTab();
    });

    const copyButton = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy the message log',
      'aria-label': 'Copy the message log',
    }, ['⧉']) as HTMLButtonElement;
    copyButton.addEventListener('click', () => {
      const lines = Array.from(
        log.querySelectorAll<HTMLElement>('.socket-row')
      ).map((row) => row.dataset.copy ?? '');
      void navigator.clipboard.writeText(lines.join('\n'));
      flash(copyButton);
      this.flashToast('Socket log copied');
    });

    this.appendSocketNotice(`Connected to ${info.url}`);
    if (info.protocol) {
      this.appendSocketNotice(`Subprotocol: ${info.protocol}`);
    }
    if (info.engineIo) {
      this.appendSocketNotice(
        info.engineIo >= 4
          ? `Socket.IO detected (Engine.IO v${info.engineIo}): heartbeats and the default namespace join are handled automatically`
          : `Socket.IO detected (Engine.IO v${info.engineIo}): heartbeats are sent automatically`
      );
    }
    if (!info.acceptValid) {
      this.appendSocketNotice(
        'Sec-WebSocket-Accept does not match the key that was sent',
        true
      );
    }

    return el('div', { class: 'tab-panel' }, [
      el('div', { class: 'response-toolbar' }, [
        el('span', { class: 'response-lang' }, [
          info.engineIo ? 'Socket.IO' : 'WebSocket',
        ]),
        clearButton,
        copyButton,
      ]),
      log,
    ]);
  }

  onSocketEntries(entries: SocketEntry[]): void {
    const log = this.socketLog;
    if (!log) {
      return;
    }

    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const rows = document.createDocumentFragment();
    for (const entry of entries) {
      rows.append(this.socketRow(entry));
      if (
        (entry.kind === 'text' || entry.kind === 'binary') &&
        !entry.heartbeat
      ) {
        this.socketMessages += 1;
      }
    }
    log.append(rows);

    while (log.childElementCount > SOCKET_ROW_LIMIT) {
      log.firstElementChild?.remove();
    }
    if (pinned) {
      log.scrollTop = log.scrollHeight;
    }
    this.syncSocketTab();
  }

  private socketRow(entry: SocketEntry): HTMLElement {
    const time = clockTime(entry.at);
    const arrow = entry.direction === 'out' ? '↑' : '↓';

    let body: string;
    if (entry.kind === 'binary') {
      const base64 = entry.base64 ?? '';
      const shown = atob(base64).length;
      const note = entry.truncated
        ? `\n<showing the first ${shown.toLocaleString('en-US')} of ` +
          `${entry.bytes.toLocaleString('en-US')} bytes>`
        : '';
      body = renderHead(base64, note, {
        hex: this.hexView,
        offsets: this.hexOffsets,
      });
    } else {
      body = entry.truncated
        ? `${entry.text}\n<showing the first ` +
          `${entry.text.length.toLocaleString('en-US')} characters of ` +
          `${entry.bytes.toLocaleString('en-US')} bytes>`
        : entry.text;
    }
    if (!body) {
      body =
        entry.kind === 'ping' || entry.kind === 'pong'
          ? '(no payload)'
          : '(empty)';
    }

    const meta = [
      entry.kind,
      formatBytes(entry.bytes),
      ...(entry.note ? [entry.note] : []),
    ].join(' · ');
    const quiet = entry.heartbeat || entry.automatic;
    const copied =
      entry.kind === 'binary' ? `<${entry.bytes} bytes of binary>` : entry.text;

    return el('div', {
      class:
        `socket-row socket-${entry.direction}` +
        (quiet ? ' socket-quiet' : '') +
        (entry.kind === 'close' ? ' socket-close' : ''),
      'data-copy': `${time} ${arrow} ${copied}`,
    }, [
      el('span', {
        class: 'socket-arrow',
        title: entry.direction === 'out' ? 'Sent' : 'Received',
      }, [arrow]),
      el('div', { class: 'socket-main' }, [
        el('div', { class: 'socket-meta' }, [
          el('span', { class: 'socket-time' }, [time]),
          meta,
        ]),
        el('div', { class: 'socket-text' }, [body]),
      ]),
    ]);
  }

  private appendSocketNotice(text: string, error = false): void {
    const log = this.socketLog;
    if (!log) {
      return;
    }
    const time = clockTime(Date.now());
    log.append(
      el('div', {
        class: `socket-row socket-notice${error ? ' error' : ''}`,
        'data-copy': `${time} • ${text}`,
      }, [
        el('span', { class: 'socket-arrow' }, ['•']),
        el('div', { class: 'socket-main' }, [
          el('span', { class: 'socket-time' }, [time]),
          text,
        ]),
      ])
    );
    log.scrollTop = log.scrollHeight;
  }

  onSocketClosed(close: SocketCloseInfo): void {
    if (!this.socketInfo) {
      return;
    }
    this.socketState = 'closed';
    this.socketLastClose = close;

    const who =
      close.by === 'client'
        ? 'Closed by you'
        : close.by === 'server'
        ? 'Closed by the server'
        : close.by === 'network'
        ? 'Connection lost'
        : 'Closed after a protocol error';
    this.appendSocketNotice(
      `${who} · ${close.code} ${close.label}` +
        (close.reason ? ` — ${close.reason}` : ''),
      close.by === 'network' || close.by === 'error'
    );
    this.syncSocketControls();
  }

  private syncSocketControls(): void {
    const info = this.socketInfo;
    const state = this.socketState;
    const live = state === 'open';

    const requestTab = this.tabButtons.get('socket');
    requestTab?.classList.toggle('hidden', !info);
    requestTab?.classList.toggle('socket-live', live);
    this.socketTabButton?.classList.toggle('socket-live', live);

    if (this.socketBadge) {
      this.socketBadge.textContent = live ? 'WebSocket open' : 'WebSocket closed';
      this.socketBadge.classList.toggle('open', live);
    }

    if (!info) {
      return;
    }

    const close = this.socketLastClose;
    const status = live
      ? `Connected to ${info.url}`
      : state === 'connecting'
      ? 'Connecting...'
      : close
      ? `Closed · ${close.code} ${close.label}. Press Send to reconnect.`
      : 'Closed. Press Send to reconnect.';
    this.socketStatus.textContent = status;
    this.socketStatus.title = status;
    this.socketStatus.classList.toggle('open', live);
    this.socketStatus.classList.toggle('connecting', state === 'connecting');
    this.socketCloseButton.classList.toggle('hidden', !live);
    this.socketCloseButton.disabled = false;
    this.socketCloseButton.textContent = 'Close socket';
    this.socketSendButton.disabled = !live;
    this.socketEventRow.classList.toggle('hidden', !info.engineIo);
  }

  private syncSocketTab(): void {
    if (this.socketTabButton) {
      this.socketTabButton.textContent = `Socket (${this.socketMessages})`;
    }
  }

  private settleSocketTabs(): void {
    this.syncSocketControls();
    this.syncSocketTab();
    if (this.socketInfo) {
      this.selectTab('socket');
    } else if (this.tabButtons.get('socket')?.classList.contains('active')) {
      this.selectTab('params');
    }
  }

  private buildHeadersPanelFor(response: ApiResponse): HTMLElement {
    const raw = response.headers
      .map((h) => `${h.name}: ${h.value}`)
      .join('\n');

    const table = el('div', { class: 'response-headers' });
    for (const header of response.headers) {
      table.append(
        el('div', { class: 'response-header-row' }, [
          el('span', { class: 'response-header-name' }, [header.name]),
          el('span', { class: 'response-header-value' }, [header.value]),
        ])
      );
    }

    const rawArea = el('textarea', {
      class: 'headers-raw hidden',
      readonly: 'true',
      spellcheck: 'false',
    }) as HTMLTextAreaElement;
    rawArea.value = raw;

    const toggle = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Show all headers as text',
      'aria-label': 'Show all headers as text',
    }, ['☰']) as HTMLButtonElement;

    const copy = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Copy all headers',
      'aria-label': 'Copy all headers',
    }, ['⧉']) as HTMLButtonElement;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(raw);
      flash(copy);
      this.flashToast('Headers copied');
    });

    let rawVisible = false;
    toggle.addEventListener('click', () => {
      rawVisible = !rawVisible;
      rawArea.classList.toggle('hidden', !rawVisible);
      table.classList.toggle('hidden', rawVisible);
      toggle.classList.toggle('active', rawVisible);
      if (rawVisible) {
        rawArea.focus();
        rawArea.select();
      }
    });

    return el('div', { class: 'tab-panel' }, [
      el('div', { class: 'response-toolbar' }, [
        el('span', { class: 'response-lang' }, [
          `${response.headers.length} headers`,
        ]),
        toggle,
        copy,
      ]),
      table,
      rawArea,
    ]);
  }

  private buildCookiesPanel(cookies: Cookie[]): HTMLElement {
    if (cookies.length === 0) {
      return el('div', { class: 'tab-panel' }, [
        el('div', { class: 'response-placeholder' }, [
          'No cookies were set by this response.',
        ]),
      ]);
    }

    const list = el('div', { class: 'cookie-list' });

    for (const cookie of cookies) {
      const flags: (Node | string)[] = [];
      if (cookie.httpOnly) {
        flags.push(el('span', { class: 'cookie-flag httponly' }, ['HttpOnly']));
      }
      if (cookie.secure) {
        flags.push(el('span', { class: 'cookie-flag' }, ['Secure']));
      }
      if (cookie.sameSite) {
        flags.push(
          el('span', { class: 'cookie-flag' }, [`SameSite=${cookie.sameSite}`])
        );
      }

      const valueField = el('input', {
        type: 'text',
        class: 'cookie-value-input',
        value: cookie.value,
      }) as HTMLInputElement;

      const useBtn = el('button', { class: 'btn btn-ghost btn-tiny' }, [
        'Send with request',
      ]) as HTMLButtonElement;
      useBtn.addEventListener('click', () => {
        this.applyCookie(cookie.name, valueField.value);
        flash(useBtn);
      });

      const dropBtn = el('button', {
        class: 'icon-btn',
        type: 'button',
        title: `Remove ${cookie.name} from this request`,
        'aria-label': `Remove ${cookie.name}`,
      }, ['×']) as HTMLButtonElement;
      dropBtn.addEventListener('click', () => {
        this.removeCookie(cookie.name);
        dropBtn.disabled = true;
        dropBtn.textContent = '✓';
      });

      const meta: string[] = [];
      if (cookie.domain) {
        meta.push(`Domain=${cookie.domain}`);
      }
      if (cookie.path) {
        meta.push(`Path=${cookie.path}`);
      }
      if (cookie.expires) {
        meta.push(`Expires=${cookie.expires}`);
      }
      if (cookie.maxAge) {
        meta.push(`Max-Age=${cookie.maxAge}`);
      }

      list.append(
        el('div', { class: 'cookie-card' }, [
          el('div', { class: 'cookie-head' }, [
            el('span', { class: 'cookie-name' }, [cookie.name]),
            ...flags,
          ]),
          el('div', { class: 'cookie-row' }, [valueField, useBtn, dropBtn]),
          meta.length
            ? el('div', { class: 'cookie-meta' }, [meta.join(' · ')])
            : el('span'),
        ])
      );
    }

    const clearAll = el('button', { class: 'btn btn-ghost btn-tiny' }, [
      'Clear all',
    ]) as HTMLButtonElement;
    clearAll.addEventListener('click', () => {
      this.cookieTable.setRows([]);
      this.request.cookies = [];
      this.syncCookieHeader();
      this.markDirty();
      this.selectTab('cookies');
      flash(clearAll);
    });

    return el('div', { class: 'tab-panel' }, [
      el('div', { class: 'response-toolbar' }, [
        el('span', { class: 'response-lang' }, [
          `${cookies.length} cookie(s) set`,
        ]),
        clearAll,
      ]),
      el('p', { class: 'env-hint' }, [
        'Edit a value and choose "Send with request" to add it to the request Cookies tab. HttpOnly cookies can be edited here because Telegraph sends the header directly rather than going through a browser cookie jar.',
      ]),
      list,
    ]);
  }

  private removeCookie(name: string): void {
    this.cookieTable.setRows(
      this.cookieTable.getRows().filter((c) => c.name !== name)
    );
    this.request.cookies = this.cookieTable.getRows();
    this.syncCookieHeader();
    this.markDirty();
  }

  private applyCookie(name: string, value: string): void {
    const rows = this.cookieTable.getRows().filter((c) => c.name !== name);
    rows.push({ name, value });
    this.cookieTable.setRows(rows);
    this.request.cookies = rows;
    this.syncCookieHeader();
    this.markDirty();
    this.selectTab('cookies');
  }
}

function formatIfJson(body: string, contentType: string): string {
  if (!contentType.toLowerCase().includes('json')) {
    return body;
  }
  try {
    return JSON.stringify(JSON.parse(body) as unknown, null, 2);
  } catch {
    return body;
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function flash(button: HTMLElement): void {
  button.classList.add('flash');
  setTimeout(() => button.classList.remove('flash'), 600);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function clockTime(at: number): string {
  const date = new Date(at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${two(date.getHours())}:${two(date.getMinutes())}:` +
    `${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}

KeyValueTable.onPickFile = (apply) => {
  pendingFilePick = apply;
  vscode.postMessage({ type: 'pickFile' });
};

VarInput.onRevealVariable = (name) =>
  vscode.postMessage({ type: 'revealVariable', name });
CodeEditor.onRevealVariable = VarInput.onRevealVariable;

const view = new RequestView();
const root = document.getElementById('app');

if (root) {
  view.mount(root);

  window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        setKnownVariables(message.vars);
        view.setFollowRedirects(message.followRedirects);
        view.setRequest(message.request, message.saved);
        break;
      case 'vars':
        setKnownVariables(message.vars);
        view.repaintAll();
        break;
      case 'curlParsed':
        view.setRequest(message.request, view.isSaved());
        view.markImported();
        break;
      case 'curlText':
        view.onCurlBuilt(message.curl);
        break;
      case 'saved':
        view.onSaved(message.request);
        break;
      case 'activitySaved':
        view.onActivitySaved(message.request);
        break;
      case 'filePicked':
        if (pendingFilePick) {
          pendingFilePick(message.path);
          pendingFilePick = null;
        } else {
          view.onFilePicked(message.path);
        }
        break;
      case 'sending':
        view.setSending(message.hasUpload);
        break;
      case 'uploadProgress':
        view.setUploadProgress(message.sent, message.total);
        break;
      case 'sentBody':
        view.onSentBody(message.info);
        break;
      case 'saveRequested':
        view.requestSave();
        break;
      case 'downloadProgress':
        view.onDownloadProgress(message.received, message.total);
        break;
      case 'downloadDone':
        view.onDownloadDone(
          message.path,
          message.bytes,
          message.result,
          message.sentUrl,
          message.binaryTextLimit
        );
        break;
      case 'streamStart':
        view.onStreamStart(message);
        break;
      case 'streamChunk':
        view.onStreamChunk(message.text, message.totalBytes);
        break;
      case 'fileChunk':
        view.onFileChunk(
          message.field,
          message.text,
          message.bytesRead,
          message.totalBytes
        );
        break;
      case 'fileDone':
        view.onFileDone(message.field, message.note);
        break;
      case 'fileBytesError':
        view.onFileBytesError(message.field, message.message);
        break;
      case 'socketEntries':
        view.onSocketEntries(message.entries);
        break;
      case 'socketClosed':
        view.onSocketClosed(message.close);
        break;
      case 'result':
        view.setResult(
          message.result,
          message.missing,
          message.sentUrl,
          message.binaryTextLimit,
          message.rawHexView,
          message.rawHexOffsets
        );
        break;
    }
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      view.requestSave();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      view.openResponseFind();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.key === 'Enter' || event.key === 'Return')
    ) {
      event.preventDefault();
      event.stopPropagation();
      view.requestSend();
    }
  });

  vscode.postMessage({ type: 'ready' });
}
