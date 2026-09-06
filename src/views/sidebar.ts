import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../core/workspace';
import type { HostToSidebar, SidebarToHost } from '../core/messages';
import { RequestPanel } from './request-panel';
import { EnvPanel } from './env-panel';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'telegraph.sidebar';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspace: Workspace
  ) {
    this.workspace.onDidChange(() => void this.pushTree());
    this.workspace.onDidChangeActive((requestId) =>
      this.post({ type: 'activeRequest', requestId })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage(
      (message: SidebarToHost) => void this.onMessage(message)
    );
  }

  private post(message: HostToSidebar): void {
    void this.view?.webview.postMessage(message);
  }

  private async pushTree(): Promise<void> {
    const collections = await this.workspace.listCollections();
    const environments = await this.workspace.listEnvironments();

    const envNames: Record<string, string> = {};
    for (const env of environments) {
      envNames[env._id] = env.name;
    }

    this.post({
      type: 'tree',
      collections,
      expanded: this.workspace.getExpanded(),
      envNames,
    });
    this.post({
      type: 'envs',
      environments: environments.map((e) => ({
        id: e._id,
        name: e.name,
        varCount: e.data.filter((v) => !v.isDisabled).length,
        dotenv: Boolean(e.dotenvPath),
      })),
      activeEnvId: this.workspace.getActiveEnvId(),
      collectionEnvModes: collections
        .filter((c) => c.settings && c.settings.envMode !== 'none')
        .map((c) => ({
          colId: c._id,
          colName: c.colName,
          mode: c.settings?.envMode ?? 'none',
          linkedNames: (c.settings?.linkedEnvIds ?? [])
            .map((id) => envNames[id])
            .filter(Boolean),
          dotenv: Boolean(c.settings?.dotenvPath),
        })),
    });

    this.post({
      type: 'history',
      entries: await this.workspace.listHistory(),
    });
  }

  private async onMessage(message: SidebarToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.pushTree();
        break;

      case 'newRequest':
        RequestPanel.createScratch();
        break;

      case 'newCollection':
        await this.workspace.createCollection();
        break;

      case 'newFolder':
        await this.workspace.createFolder(
          message.colId,
          message.containerId
        );
        break;

      case 'newRequestIn': {
        const created = await this.workspace.createRequestIn(
          message.colId,
          message.containerId
        );
        if (created) {
          RequestPanel.openSaved(created);
        }
        break;
      }

      case 'openRequest': {
        const request = await this.workspace.getRequest(
          message.colId,
          message.requestId
        );
        if (request) {
          RequestPanel.openSaved(request);
        }
        break;
      }

      case 'rename': {
        const renamed = await this.workspace.rename(
          message.colId,
          message.nodeId,
          message.kind
        );
        if (renamed) {
          RequestPanel.refreshTitle(renamed);
        }
        break;
      }

      case 'requestDeleteInfo': {
        const info = await this.workspace.describeDelete(
          message.colId,
          message.nodeId,
          message.kind
        );
        if (info) {
          this.post({
            type: 'deleteInfo',
            colId: message.colId,
            nodeId: message.nodeId,
            kind: message.kind,
            ...info,
          });
        }
        break;
      }

      case 'delete': {
        const removed = await this.workspace.delete(
          message.colId,
          message.nodeId,
          message.kind
        );
        RequestPanel.closeFor(removed);
        break;
      }

      case 'toggle':
        await this.workspace.setExpanded(message.nodeId, message.expanded);
        break;

      case 'newEnv': {
        const created = await this.workspace.createEnvironment();
        if (created) {
          EnvPanel.openEnvironment(created);
        }
        break;
      }

      case 'openEnv': {
        const environment = await this.workspace.getEnvironment(
          message.envId
        );
        if (environment) {
          EnvPanel.openEnvironment(environment);
        }
        break;
      }

      case 'activateEnv':
        await this.workspace.setActiveEnv(message.envId);
        break;

      case 'renameEnv':
        await this.workspace.renameEnvironment(message.envId);
        break;

      case 'requestEnvDeleteInfo': {
        const info = await this.workspace.describeEnvironmentDelete(
          message.envId
        );
        if (info) {
          this.post({ type: 'envDeleteInfo', envId: message.envId, ...info });
        }
        break;
      }

      case 'deleteEnv':
        EnvPanel.closeFor([message.envId]);
        await this.workspace.deleteEnvironment(message.envId);
        break;

      case 'openCollectionEnv': {
        const collection = await this.workspace.getCollection(message.colId);
        if (collection) {
          EnvPanel.openCollectionSettings(collection._id, collection.colName);
        }
        break;
      }

      case 'import':
        await this.workspace.importFile();
        break;

      case 'importCurl': {
        const request = await this.workspace.importCurl();
        if (request) {
          RequestPanel.openScratchFrom(request);
        }
        break;
      }

      case 'exportCollection':
        await this.workspace.exportCollection(message.colId);
        break;

      case 'exportEnv':
        await this.workspace.exportEnvironment(message.envId);
        break;

      case 'copyCurl':
        await this.workspace.copyAsCurl(message.colId, message.requestId);
        break;

      case 'clearHistory':
        await this.workspace.clearHistory();
        break;

      case 'openHistory':
        break;

      case 'move':
        await this.workspace.moveNode(
          message.colId,
          message.nodeId,
          message.kind,
          message.targetContainerId,
          message.beforeNodeId,
          message.copy,
          message.targetColId
        );
        break;

      case 'moveCollection':
        await this.workspace.moveCollection(
          message.colId,
          message.beforeColId
        );
        break;

      case 'convertEnv':
        await this.workspace.convertEnv(message.colId, message.to);
        break;

      case 'revealVariable':
        await this.revealVariable(message.name);
        break;

      case 'duplicate':
        await this.workspace.duplicate(
          message.colId,
          message.nodeId,
          message.kind
        );
        break;

      case 'linkDotenv': {
        const created = await this.workspace.importDotenv();
        if (created) {
          EnvPanel.openEnvironment(created);
        }
        break;
      }

      case 'reloadDotenv':
        await this.workspace.reloadDotenv(message.envId);
        break;

      case 'exportDotenv':
        await this.workspace.exportDotenv(message.envId);
        break;

      case 'replayHistory': {
        const entries = await this.workspace.listHistory();
        const entry = entries.find((e) => e._id === message.entryId);
        if (entry) {
          RequestPanel.openScratchFromHistory(entry);
        }
        break;
      }

      case 'refresh':
        this.workspace.refresh();
        break;
    }
  }

  async revealVariable(name: string): Promise<void> {
    const found = await this.workspace.findVariableSource(name);

    if (!found) {
      void vscode.window.showWarningMessage(
        `"${name}" is not defined in any environment.`
      );
      return;
    }

    if (found.kind === 'file') {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(found.path)
      );
      const editor = await vscode.window.showTextDocument(document);
      const index = document
        .getText()
        .split(/\r?\n/)
        .findIndex((line) =>
          new RegExp(`^\\s*(export\\s+)?${escapeRegExp(name)}\\s*=`).test(line)
        );
      if (index >= 0) {
        const position = new vscode.Position(index, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      }
      return;
    }

    const environment = await this.workspace.getEnvironment(found.envId);
    if (environment) {
      EnvPanel.openEnvironment(environment, name);
    }
  }

  private render(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'sidebar.js')
    );
    const nonce = randomUUID().replace(/-/g, '');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link href="${styleUri}" rel="stylesheet">
<title>Telegraph</title>
</head>
<body class="sidebar">
<div class="sidebar-tabs">
  <button id="tab-collections" class="sidebar-tab active">Collections</button>
  <button id="tab-env" class="sidebar-tab">Env</button>
  <button id="tab-hist" class="sidebar-tab">Activity</button>
</div>
<div id="pane-collections">
  <div class="sidebar-actions">
    <button id="new-request" class="btn btn-primary btn-sm">New Request</button>
    <button id="new-collection" class="btn btn-ghost btn-sm">New Collection</button>
  </div>
  <div class="sidebar-actions">
    <button id="import" class="btn btn-ghost btn-sm">Import</button>
    <button id="import-curl" class="btn btn-ghost btn-sm">Import cURL</button>
  </div>
  <div class="sidebar-search">
    <input id="search" type="text" class="search-input" placeholder="Search requests" spellcheck="false">
  </div>
  <div id="tree" class="tree"></div>
</div>
<div id="pane-env" class="hidden">
  <div class="sidebar-actions">
    <button id="new-env" class="btn btn-primary btn-sm">New Environment</button>
  </div>
  <div id="env-list" class="tree"></div>
</div>
<div id="pane-hist" class="hidden">
  <div class="sidebar-actions">
    <button id="new-activity-request" class="btn btn-primary btn-sm">New Request</button>
    <button id="clear-hist" class="btn btn-ghost btn-sm">Clear</button>
  </div>
  <div id="hist-list" class="tree"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
