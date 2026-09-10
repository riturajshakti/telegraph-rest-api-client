import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { sendRequest, sendsBody, type SendOptions } from '../core/http';
import { createEmptyRequest, type ApiRequest } from '../core/types';
import { resolveRequest, collectUnresolved } from '../core/variables';
import { parseCurl, toCurl } from '../core/formats';
import type { VarInfo } from '../core/messages';

import type { HostToWebview, WebviewToHost } from '../core/messages';
import type { Workspace } from '../core/workspace';
import type { SendResult } from '../core/types';

const VIEW_TYPE = 'telegraph.requestView';

function nonce(): string {
  return randomUUID().replace(/-/g, '');
}

function resolveOptions(): SendOptions {
  const config = vscode.workspace.getConfiguration('telegraph');
  return {
    timeout: config.get<number>('requestTimeout', 0),
    followRedirects: config.get<boolean>('followRedirects', true),
    responseLimitBytes: config.get<number>('responseLimit', 0) * 1024 * 1024,
  };
}

/** How the Raw tabs render binary bytes. */
function hexViewFlags(): { rawHexView: boolean; rawHexOffsets: boolean } {
  const config = vscode.workspace.getConfiguration('telegraph');
  return {
    rawHexView: config.get<boolean>('rawHexView', true),
    rawHexOffsets: config.get<boolean>('rawHexOffsets', true),
  };
}

/** Largest binary response that may be rendered as text, capped at 20 MB. */
function binaryTextLimitBytes(): number {
  const config = vscode.workspace.getConfiguration('telegraph');
  const mb = Math.min(Math.max(config.get<number>('binaryTextLimit', 2), 0), 20);
  return mb * 1024 * 1024;
}

export class RequestPanel {
  private static readonly panels = new Map<string, RequestPanel>();
  private static workspace: Workspace;
  private static extensionUri: vscode.Uri;

  private readonly disposables: vscode.Disposable[] = [];
  private inFlight: { aborted: boolean; onAbort?: () => void } | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private request: ApiRequest,
    private saved: boolean
  ) {
    this.panel.webview.html = this.render(panel.webview);
    this.panel.title = request.name || 'New Request';

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToHost) => void this.onMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) {
          RequestPanel.workspace.setActiveRequest(
            this.saved ? this.request._id : null
          );
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.disposables.push(
      RequestPanel.workspace.onDidChange(() => {
        void this.currentVars().then((vars) =>
          this.post({ type: 'vars', vars })
        );
      })
    );
  }

  private lastBytes: Uint8Array | undefined;
  private lastUrl = '';
  private lastContentType = '';

  /** Picks a sensible save name from the URL, falling back to the MIME type. */
  private static suggestFileName(url: string, contentType: string): string {
    const EXT: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/tiff': 'tiff',
      'image/x-icon': 'ico',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/gzip': 'gz',
      'application/x-tar': 'tar',
      'application/wasm': 'wasm',
      'application/epub+zip': 'epub',
      'font/woff': 'woff',
      'font/woff2': 'woff2',
      'font/ttf': 'ttf',
      'font/otf': 'otf',
    };

    let name = '';
    try {
      const parsed = new URL(url);
      name = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    } catch {
      name = '';
    }

    if (name && name.includes('.')) {
      return name;
    }

    const mime = contentType.split(';')[0].trim().toLowerCase();
    const ext = EXT[mime] ?? 'bin';
    return `${name || 'response'}.${ext}`;
  }

  static onRevealVariable: ((name: string) => Promise<void>) | null = null;

  private static markDirtyState(
    panel: vscode.WebviewPanel,
    dirty: boolean
  ): void {
    const base = panel.title.replace(/\s*●$/, '');
    panel.title = dirty ? `${base} ●` : base;
  }

  /** Tells the focused panel to save, for the Cmd/Ctrl+S keybinding. */
  static saveActive(): boolean {
    for (const panel of RequestPanel.panels.values()) {
      if (panel.panel.active) {
        panel.post({ type: 'saveRequested' });
        return true;
      }
    }
    return false;
  }

  static init(workspace: Workspace, extensionUri: vscode.Uri): void {
    RequestPanel.workspace = workspace;
    RequestPanel.extensionUri = extensionUri;
  }

  static createScratch(): void {
    const request = createEmptyRequest(randomUUID());
    request.url = 'https://jsonplaceholder.typicode.com/todos/1';
    RequestPanel.spawn(request, false);
  }

  static openScratchFrom(request: ApiRequest): void {
    RequestPanel.spawn(request, false);
  }

  static openScratchFromHistory(entry: {
    name: string;
    url: string;
    method: ApiRequest['method'];
    requestId: string;
    request?: ApiRequest;
  }): void {
    // Reuse the original request id so re-sending updates the same Activity
    // row instead of creating a duplicate.
    const id = entry.requestId || randomUUID();

    const open = RequestPanel.panels.get(id);
    if (open) {
      open.panel.reveal();
      return;
    }

    // Prefer the stored snapshot so body, headers, query, auth and cookies
    // all come back; fall back to the summary for older entries.
    const request = entry.request
      ? ({ ...entry.request, _id: id } as ApiRequest)
      : (() => {
          const fresh = createEmptyRequest(id);
          fresh.name = entry.name || 'New Request';
          fresh.url = entry.url;
          fresh.method = entry.method;
          return fresh;
        })();

    RequestPanel.spawn(request, false);
  }

  static openSaved(request: ApiRequest): void {
    const existing = RequestPanel.panels.get(request._id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    RequestPanel.spawn(request, true);
  }

  static closeFor(requestIds: string[]): void {
    for (const id of requestIds) {
      RequestPanel.panels.get(id)?.panel.dispose();
    }
  }

  static refreshTitle(request: ApiRequest): void {
    const panel = RequestPanel.panels.get(request._id);
    if (panel) {
      panel.request = request;
      panel.panel.title = request.name;
    }
  }

  private static spawn(request: ApiRequest, saved: boolean): void {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      request.name || 'New Request',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(RequestPanel.extensionUri, 'dist'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(
      RequestPanel.extensionUri,
      'media',
      'tab-request.svg'
    );

    const instance = new RequestPanel(panel, request, saved);
    RequestPanel.panels.set(request._id, instance);
  }

  private async currentVars(): Promise<Record<string, VarInfo>> {
    const scope = await RequestPanel.workspace.scopeFor(this.request.colId);
    const vars: Record<string, VarInfo> = {};
    for (const [name, value] of scope.values) {
      vars[name] = { value, source: scope.sources.get(name) ?? '' };
    }
    return vars;
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({
          type: 'init',
          request: this.request,
          saved: this.saved,
          vars: await this.currentVars(),
          followRedirects: resolveOptions().followRedirects,
        });
        if (this.saved) {
          RequestPanel.workspace.setActiveRequest(this.request._id);
        }
        break;

      case 'parseCurl': {
        const parsed = parseCurl(message.text);
        if (parsed) {
          parsed._id = this.request._id;
          parsed.colId = this.request.colId;
          parsed.containerId = this.request.containerId;
          parsed.sortNum = this.request.sortNum;
          parsed.name = this.request.name;
          this.request = parsed;
          this.post({ type: 'curlParsed', request: parsed });
        }
        break;
      }

      case 'resendBinary': {
        const scope = await RequestPanel.workspace.scopeFor(
          message.request.colId
        );
        const resolved = resolveRequest(message.request, scope);

        if (message.mode === 'text') {
          this.post({ type: 'sending', hasUpload: false });
          const result = await sendRequest(resolved, {
            ...resolveOptions(),
            binaryMode: 'text',
          });
          this.lastBytes = result.ok ? result.bytes : undefined;
          this.lastUrl = resolved.url;
          this.lastContentType = result.ok ? result.response.contentType : '';
          const posted: SendResult = result.ok
            ? { ok: true, response: result.response }
            : result;
          this.post({
            type: 'result',
            result: posted,
            missing: [],
            sentUrl: resolved.url,
            binaryTextLimit: binaryTextLimitBytes(),
          ...hexViewFlags(),
            ...hexViewFlags(),
          });
          break;
        }

        const target = await vscode.window.showSaveDialog({
          saveLabel: 'Save response',
          defaultUri: vscode.Uri.file(
            RequestPanel.suggestFileName(resolved.url, this.lastContentType)
          ),
        });
        if (!target) {
          break;
        }

        this.post({ type: 'downloadProgress', received: 0, total: 0 });
        const signal = { aborted: false } as {
          aborted: boolean;
          onAbort?: () => void;
        };
        this.inFlight = signal;

        const result = await sendRequest(resolved, {
          ...resolveOptions(),
          signal,
          binaryMode: 'download',
          downloadPath: target.fsPath,
          onDownloadProgress: (received, total) => {
            this.post({ type: 'downloadProgress', received, total });
          },
        });
        this.inFlight = null;

        if (result.ok) {
          // Send the whole response so the view can show status, headers,
          // cookies and redirects alongside the saved-file note.
          this.post({
            type: 'downloadDone',
            path: target.fsPath,
            bytes: result.response.bodyBytes,
            result: { ok: true, response: result.response },
            sentUrl: resolved.url,
            binaryTextLimit: binaryTextLimitBytes(),
          ...hexViewFlags(),
            ...hexViewFlags(),
          });
        } else {
          // Put the response area back so the view is not stuck on
          // "Cancelling...", and report why the download stopped.
          this.post({
            type: 'result',
            result,
            missing: [],
            sentUrl: resolved.url,
            binaryTextLimit: binaryTextLimitBytes(),
          ...hexViewFlags(),
            ...hexViewFlags(),
          });
          if (!/cancelled/i.test(result.error.message)) {
            void vscode.window.showErrorMessage(
              `Download failed: ${result.error.message}`
            );
          }
        }
        break;
      }

      case 'revealFile': {
        if (message.path) {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(message.path)
          );
        }
        break;
      }

      case 'downloadBody': {
        if (!this.lastBytes) {
          void vscode.window.showWarningMessage('No response body to download.');
          break;
        }
        const target = await vscode.window.showSaveDialog({
          saveLabel: 'Save response',
          defaultUri: vscode.Uri.file(
            RequestPanel.suggestFileName(this.lastUrl, this.lastContentType)
          ),
        });
        if (!target) {
          break;
        }
        await vscode.workspace.fs.writeFile(target, this.lastBytes);
        void vscode.window.showInformationMessage(
          `Saved ${this.lastBytes.byteLength.toLocaleString('en-US')} bytes.`
        );
        break;
      }

      case 'buildCurl': {
        const scope = await RequestPanel.workspace.scopeFor(
          message.request.colId
        );
        this.post({
          type: 'curlText',
          curl: toCurl(resolveRequest(message.request, scope)),
        });
        break;
      }

      case 'send': {
        this.request = message.request;
        this.panel.title = this.request.name || 'New Request';
        // GET and HEAD send no body, so no upload can be in progress.
        const usesFiles =
          sendsBody(this.request.method) &&
          (this.request.body.type === 'binary'
            ? Boolean(this.request.body.binaryPath)
            : (this.request.body.form ?? []).some((f) => f.isFile));
        // Persist before the request goes out so edits are never lost if it
        // hangs, fails, or the window is closed mid-flight.
        if (!this.saved) {
          const tracked = await RequestPanel.workspace.beginHistory(
            this.request
          );
          if (tracked) {
            this.post({ type: 'activitySaved', request: this.request });
          }
        }

        this.post({ type: 'sending', hasUpload: usesFiles });

        if (this.saved) {
          const stored = await RequestPanel.workspace.saveRequest(
            this.request,
            true
          );
          if (stored) {
            this.request = stored;
            this.post({ type: 'saved', request: stored });
          }
        }

        const scope = await RequestPanel.workspace.scopeFor(
          this.request.colId
        );
        const missing = collectUnresolved(this.request, scope);
        const resolved = resolveRequest(this.request, scope);

        const signal = { aborted: false } as {
          aborted: boolean;
          onAbort?: () => void;
        };
        this.inFlight = signal;
        const result = await sendRequest(resolved, {
          ...resolveOptions(),
          signal,
          // Stop at the headers for a binary payload: the view offers a choice
          // and the body is fetched only once that choice is made.
          binaryMode: 'probe',
          onBodyPrepared: (info) => {
            this.post({ type: 'sentBody', info });
          },
          onStreamStart: (info) => {
            this.post({ type: 'streamStart', ...info });
          },
          onStreamChunk: (text, totalBytes) => {
            this.post({ type: 'streamChunk', text, totalBytes });
          },
          ...(usesFiles
            ? {
                onUploadProgress: (sent: number, total: number) => {
                  this.post({ type: 'uploadProgress', sent, total });
                },
              }
            : {}),
        });
        this.inFlight = null;
        this.lastBytes = result.ok ? result.bytes : undefined;
        this.lastUrl = resolved.url;
        this.lastContentType = result.ok ? result.response.contentType : '';
        // The raw bytes stay on the host: they are only needed for a download,
        // and posting a large buffer across the webview boundary is wasteful
        // and can drop the whole message.
        const posted: SendResult = result.ok
          ? { ok: true, response: result.response }
          : result;
        this.post({
          type: 'result',
          result: posted,
          missing,
          sentUrl: resolved.url,
          binaryTextLimit: binaryTextLimitBytes(),
          ...hexViewFlags(),
        });

        await RequestPanel.workspace.recordHistory(
          this.request,
          result,
          resolved.url
        );
        break;
      }

      case 'dirty':
        RequestPanel.markDirtyState(this.panel, message.dirty);
        break;

      case 'save': {
        // Unsaved requests belong to Activity: save there directly, creating
        // the entry if this request has not been sent yet. Use the
        // "+ Collection" button to file it into a collection instead.
        if (!this.saved) {
          this.request = message.request;
          await RequestPanel.workspace.beginHistory(message.request);
          this.panel.title = message.request.name || 'New Request';
          this.post({ type: 'activitySaved', request: message.request });
          return;
        }

        const stored = await RequestPanel.workspace.saveRequest(
          message.request,
          this.saved
        );
        if (!stored) {
          return;
        }

        if (!this.saved) {
          RequestPanel.panels.delete(this.request._id);
          RequestPanel.panels.set(stored._id, this);
          this.saved = true;
        }

        this.request = stored;
        this.panel.title = stored.name;
        this.post({ type: 'saved', request: stored });
        RequestPanel.workspace.setActiveRequest(stored._id);
        break;
      }

      case 'pickFile': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Use file as body',
        });
        if (picked?.[0]) {
          this.post({ type: 'filePicked', path: picked[0].fsPath });
        }
        break;
      }

      case 'loadFileBytes': {
        // Stream on a worker thread so the host never blocks and the text
        // appears progressively.
        const workerPath = vscode.Uri.joinPath(
          RequestPanel.extensionUri,
          'dist',
          'read-file-worker.js'
        ).fsPath;

        const field = message.field;

        try {
          const worker = new Worker(workerPath, {
            workerData: {
              path: message.path,
              maxBytes: 5 * 1024 * 1024,
              chunkSize: 64 * 1024,
            },
          });

          worker.on('message', (msg: Record<string, unknown>) => {
            if (msg.type === 'chunk') {
              this.post({
                type: 'fileChunk',
                field,
                text: String(msg.text ?? ''),
                bytesRead: Number(msg.bytesRead ?? 0),
                totalBytes: Number(msg.totalBytes ?? 0),
              });
              return;
            }

            if (msg.type === 'done') {
              this.post({
                type: 'fileDone',
                field,
                bytesRead: Number(msg.bytesRead ?? 0),
                totalBytes: Number(msg.totalBytes ?? 0),
                note: String(msg.note ?? ''),
              });
              void worker.terminate();
              return;
            }

            if (msg.type === 'error') {
              this.post({
                type: 'fileBytesError',
                field,
                message: String(msg.message ?? 'Could not read the file.'),
              });
              void worker.terminate();
            }
          });

          worker.once('error', (err) => {
            this.post({ type: 'fileBytesError', field, message: err.message });
          });
        } catch (err) {
          this.post({
            type: 'fileBytesError',
            field,
            message: (err as Error).message,
          });
        }
        break;
      }

      case 'abort':
        if (this.inFlight) {
          this.inFlight.aborted = true;
          this.inFlight.onAbort?.();
        }
        break;

      case 'saveToCollection': {
        const stored = await RequestPanel.workspace.saveRequest(
          message.request,
          false
        );
        if (stored) {
          RequestPanel.panels.delete(this.request._id);
          RequestPanel.panels.set(stored._id, this);
          this.saved = true;
          this.request = stored;
          this.panel.title = stored.name;
          this.post({ type: 'saved', request: stored });
          RequestPanel.workspace.setActiveRequest(stored._id);
        }
        break;
      }

      case 'revealVariable':
        await RequestPanel.onRevealVariable?.(message.name);
        break;

      case 'setHexView':
        await vscode.workspace
          .getConfiguration('telegraph')
          .update('rawHexView', message.hex, vscode.ConfigurationTarget.Global);
        await vscode.workspace
          .getConfiguration('telegraph')
          .update(
            'rawHexOffsets',
            message.offsets,
            vscode.ConfigurationTarget.Global
          );
        break;

      case 'setFollowRedirects':
        await vscode.workspace
          .getConfiguration('telegraph')
          .update(
            'followRedirects',
            message.value,
            vscode.ConfigurationTarget.Global
          );
        break;

      case 'newRequest':
        RequestPanel.createScratch();
        break;
    }
  }

  private render(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(RequestPanel.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(RequestPanel.extensionUri, 'dist', 'webview.css')
    );
    const csp = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${csp}';">
<link href="${styleUri}" rel="stylesheet">
<title>Telegraph</title>
</head>
<body>
<div id="app"></div>
<script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    RequestPanel.panels.delete(this.request._id);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
