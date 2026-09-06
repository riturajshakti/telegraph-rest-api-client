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
    })
  );
}

export function deactivate(): void {
  // no cleanup required
}
