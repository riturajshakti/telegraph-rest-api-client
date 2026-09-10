import * as vscode from 'vscode';
import { Workspace } from './core/workspace';
import { SidebarProvider } from './views/sidebar';
import { RequestPanel } from './views/request-panel';
import { EnvPanel } from './views/env-panel';

export function activate(context: vscode.ExtensionContext): void {
  const workspace = new Workspace(context);
  RequestPanel.init(workspace, context.extensionUri);
  EnvPanel.init(workspace, context.extensionUri);

  const sidebar = new SidebarProvider(context.extensionUri, workspace);
  RequestPanel.onRevealVariable = (name) => sidebar.revealVariable(name);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),

    vscode.commands.registerCommand('telegraph.newRequest', () => {
      RequestPanel.createScratch();
    }),

    vscode.commands.registerCommand('telegraph.newCollection', () => {
      void workspace.createCollection();
    }),

    vscode.commands.registerCommand('telegraph.refresh', () => {
      workspace.refresh();
    }),

    vscode.commands.registerCommand('telegraph.backupAll', () => {
      void workspace.backupAll();
    }),

    vscode.commands.registerCommand('telegraph.importAll', () => {
      void workspace.importAllFolder();
    }),

    // Claims Cmd/Ctrl+S while a Telegraph panel is focused, so VS Code's own
    // Save does not open a file dialog for a webview that has no document.
    vscode.commands.registerCommand('telegraph.saveActive', () => {
      // Ask both: a stale "active" flag on one kind must not swallow the
      // keystroke meant for the other.
      const handled = RequestPanel.saveActive();
      EnvPanel.saveActive();
      void handled;
    })
  );
}

export function deactivate(): void {
  // no cleanup required
}
