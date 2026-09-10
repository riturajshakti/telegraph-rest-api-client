import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../core/workspace';
import type { Environment } from '../core/types';
import type { EnvToHost, HostToEnv } from '../webview/env';

const VIEW_TYPE = 'telegraph.envView';

type Target =
  | { kind: 'env'; id: string }
  | { kind: 'collection'; id: string };

export class EnvPanel {
  private static readonly panels = new Map<string, EnvPanel>();
  private static workspace: Workspace;
  private static extensionUri: vscode.Uri;

  private readonly disposables: vscode.Disposable[] = [];
  private focusKey: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly target: Target
  ) {
    this.panel.webview.html = this.render(panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (message: EnvToHost) => void this.onMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Tells the focused panel to save, for the Cmd/Ctrl+S keybinding. */
  static saveActive(): boolean {
    for (const panel of EnvPanel.panels.values()) {
      if (panel.panel.active) {
        panel.post({ type: 'saveRequested' });
        return true;
      }
    }
    return false;
  }

  static init(workspace: Workspace, extensionUri: vscode.Uri): void {
    EnvPanel.workspace = workspace;
    EnvPanel.extensionUri = extensionUri;
  }

  static openEnvironment(environment: Environment, focusKey?: string): void {
    EnvPanel.spawn(
      { kind: 'env', id: environment._id },
      environment.name,
      focusKey
    );
  }

  static openCollectionSettings(colId: string, colName: string): void {
    EnvPanel.spawn({ kind: 'collection', id: colId }, `${colName} Env`);
  }

  static closeFor(ids: string[]): void {
    for (const id of ids) {
      EnvPanel.panels.get(id)?.panel.dispose();
    }
  }

  private static spawn(
    target: Target,
    title: string,
    focusKey?: string
  ): void {
    const key = `${target.kind}:${target.id}`;
    const existing = EnvPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (focusKey) {
        existing.focusKey = focusKey;
        void existing.pushState();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(EnvPanel.extensionUri, 'dist'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(
      EnvPanel.extensionUri,
      'media',
      'tab-env.svg'
    );

    const instance = new EnvPanel(panel, target);
    instance.focusKey = focusKey;
    EnvPanel.panels.set(key, instance);
    EnvPanel.panels.set(target.id, instance);
  }

  private post(message: HostToEnv): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: EnvToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.pushState();
        break;

      case 'saveEnv':
        await EnvPanel.workspace.saveEnvironment(message.environment);
        this.panel.title = message.environment.name;
        this.post({ type: 'saved' });
        break;

      case 'saveSettings':
        await EnvPanel.workspace.setCollectionSettings(
          message.colId,
          message.settings
        );
        this.post({ type: 'saved' });
        break;

      case 'linkDotenv': {
        const created = await EnvPanel.workspace.importDotenv();
        if (created) {
          EnvPanel.openEnvironment(created);
        }
        await this.pushState();
        break;
      }

      case 'convertEnv':
        await EnvPanel.workspace.convertEnv(message.colId, message.to);
        await this.pushState();
        break;
    }
  }

  async pushState(): Promise<void> {
    if (this.target.kind === 'env') {
      const environment = await EnvPanel.workspace.getEnvironment(
        this.target.id
      );
      if (environment) {
        this.post({
          type: 'initEnv',
          environment,
          focusKey: this.focusKey,
        });
        this.focusKey = undefined;
      }
      return;
    }

    const collection = await EnvPanel.workspace.getCollection(this.target.id);
    if (!collection) {
      return;
    }

    const environments = await EnvPanel.workspace.listEnvironments();
    this.post({
      type: 'initCollection',
      colId: collection._id,
      colName: collection.colName,
      settings: collection.settings ?? { envMode: 'none' },
      available: environments.map((e) => ({
        id: e._id,
        name: e.name,
        dotenv: Boolean(e.dotenvPath),
      })),
    });
  }

  private render(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(EnvPanel.extensionUri, 'dist', 'env.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(EnvPanel.extensionUri, 'dist', 'webview.css')
    );
    const csp = randomUUID().replace(/-/g, '');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${csp}';">
<link href="${styleUri}" rel="stylesheet">
<title>Telegraph</title>
</head>
<body class="env-body">
<div id="app"></div>
<script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    EnvPanel.panels.delete(`${this.target.kind}:${this.target.id}`);
    EnvPanel.panels.delete(this.target.id);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
