import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Storage, nextSortNum, siblingsOf, SORT_STEP } from './storage';
import { createEmptyRequest } from './types';
import type {
  ApiRequest,
  Collection,
  Environment,
  Folder,
  HistoryEntry,
  SendResult,
} from './types';
import { buildScope, resolveRequest, type VariableScope } from './variables';
import {
  toTelegraph,
  fromTelegraph,
  toPostmanCollection,
  toPostmanEnvironment,
  fromPostmanCollection,
  fromPostmanEnvironment,
  fromOpenApi,
  parseCurl,
  toCurl,
} from './formats';
import { nextSortNum as nextSort } from './storage';
import { parseDotenv, toDotenv } from './dotenv';
import type { NodeKind } from './messages';

const EXPANDED_KEY = 'telegraph.expandedNodes';
const ACTIVE_ENV_KEY = 'telegraph.activeEnvId';

export class Workspace {
  private readonly storage: Storage;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly activeEmitter = new vscode.EventEmitter<string | null>();

  readonly onDidChange = this.emitter.event;
  readonly onDidChangeActive = this.activeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storage = new Storage(context.globalStorageUri.fsPath);
  }

  listCollections(): Promise<Collection[]> {
    return this.storage.listCollections();
  }

  listHistory(): Promise<HistoryEntry[]> {
    return this.storage.listHistory();
  }

  /**
   * Persists the request into Activity before it is sent, so edits survive even
   * if the request hangs or the window closes mid-flight. Returns false when
   * the request belongs to a collection and is not tracked here.
   */
  async beginHistory(request: ApiRequest): Promise<boolean> {
    if (request.colId) {
      return false;
    }

    const snapshot = JSON.parse(JSON.stringify(request)) as ApiRequest;

    if (await this.updateHistoryRequest(snapshot)) {
      return true;
    }

    await this.storage.addHistory({
      _id: randomUUID(),
      name: request.name,
      url: request.url,
      method: request.method,
      status: 0,
      statusText: '',
      durationMs: 0,
      bytes: 0,
      at: new Date().toISOString(),
      colId: '',
      requestId: request._id,
      request: snapshot,
    });
    this.notify();
    return true;
  }

  /** Fills in the outcome on the entry created by `beginHistory`. */
  async recordHistory(
    request: ApiRequest,
    result: SendResult,
    sentUrl: string
  ): Promise<void> {
    if (request.colId) {
      return;
    }

    const history = await this.storage.listHistory();
    const entry = history.find((e) => e.requestId === request._id);
    if (!entry) {
      return;
    }

    entry.url = sentUrl || request.url;
    entry.status = result.ok ? result.response.status : 0;
    entry.statusText = result.ok ? result.response.statusText : '';
    entry.durationMs = result.ok ? result.response.timing.total : 0;
    entry.bytes = result.ok ? result.response.bodyBytes : 0;
    entry.at = new Date().toISOString();
    if (result.ok) {
      delete entry.error;
    } else {
      entry.error = result.error.message;
    }

    await this.storage.replaceHistory(history);
    this.notify();
  }

  async updateHistoryRequest(request: ApiRequest): Promise<boolean> {
    const history = await this.storage.listHistory();
    const entry = history.find((e) => e.requestId === request._id);
    if (!entry) {
      return false;
    }

    entry.request = JSON.parse(JSON.stringify(request)) as ApiRequest;
    entry.name = request.name;
    entry.url = request.url;
    entry.method = request.method;
    await this.storage.replaceHistory(history);
    this.notify();
    return true;
  }

  async clearHistory(): Promise<void> {
    await this.storage.clearHistory();
    this.notify();
  }

  listEnvironments(): Promise<Environment[]> {
    return this.storage.listEnvironments();
  }

  getActiveEnvId(): string | null {
    return this.context.globalState.get<string | null>(ACTIVE_ENV_KEY, null);
  }

  async setActiveEnv(envId: string | null): Promise<void> {
    await this.context.globalState.update(ACTIVE_ENV_KEY, envId);
    this.notify();
  }

  async scopeFor(colId: string): Promise<VariableScope> {
    const collection = colId
      ? await this.storage.getCollection(colId)
      : undefined;
    const environments = await this.storage.listEnvironments();
    return buildScope(collection, environments, this.getActiveEnvId());
  }

  async createEnvironment(): Promise<Environment | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Environment name',
      placeHolder: 'Development',
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return undefined;
    }
    const environment = await this.storage.createEnvironment(name.trim());
    if (!this.getActiveEnvId()) {
      await this.context.globalState.update(ACTIVE_ENV_KEY, environment._id);
    }
    this.notify();
    return environment;
  }

  async getEnvironment(id: string): Promise<Environment | undefined> {
    return this.storage.getEnvironment(id);
  }

  async saveEnvironment(environment: Environment): Promise<void> {
    await this.storage.saveEnvironment(environment);
    this.notify();
  }

  async renameEnvironment(id: string): Promise<void> {
    const environment = await this.storage.getEnvironment(id);
    if (!environment) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Rename environment',
      value: environment.name,
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name || name.trim() === environment.name) {
      return;
    }
    environment.name = name.trim();
    await this.storage.saveEnvironment(environment);
    this.notify();
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.storage.deleteEnvironment(id);
    if (this.getActiveEnvId() === id) {
      await this.context.globalState.update(ACTIVE_ENV_KEY, null);
    }
    this.notify();
  }

  async importDotenv(): Promise<Environment | undefined> {
    // No `filters`: macOS hides dot-files when a filter list is supplied, and
    // .env has no extension to match on anyway. Users can press Cmd+Shift+.
    // in the dialog to reveal hidden files.
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Link .env file',
      title: 'Select a .env file (press Cmd+Shift+. to show hidden files)',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.[0]) {
      return undefined;
    }

    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      text = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not read that file: ${(err as Error).message}`
      );
      return undefined;
    }

    const { variables, errors } = parseDotenv(text);

    if (variables.length === 0) {
      void vscode.window.showErrorMessage(
        errors.length
          ? `No valid variables found. ${errors[0]}`
          : 'That file contains no variables.'
      );
      return undefined;
    }

    if (errors.length > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `${variables.length} variable(s) parsed, ${errors.length} line(s) skipped.`,
        { modal: true, detail: errors.slice(0, 8).join('\n') },
        'Import anyway'
      );
      if (proceed !== 'Import anyway') {
        return undefined;
      }
    }

    const fileName = picked[0].fsPath.split('/').pop() ?? '.env';
    const name = await vscode.window.showInputBox({
      prompt: 'Environment name',
      value: fileName.replace(/^\./, '') || 'env',
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return undefined;
    }

    const environment = await this.storage.createEnvironment(name.trim());
    environment.data = variables;
    environment.dotenvPath = picked[0].fsPath;
    await this.storage.saveEnvironment(environment);
    this.notify();

    void vscode.window.showInformationMessage(
      `Linked ${fileName} — ${variables.length} variable(s) imported.`
    );
    return environment;
  }

  async reloadDotenv(envId: string): Promise<void> {
    const environment = await this.storage.getEnvironment(envId);
    if (!environment?.dotenvPath) {
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(environment.dotenvPath)
      );
      const { variables, errors } = parseDotenv(
        Buffer.from(bytes).toString('utf8')
      );
      environment.data = variables;
      await this.storage.saveEnvironment(environment);
      this.notify();
      void vscode.window.showInformationMessage(
        errors.length
          ? `Reloaded ${variables.length} variable(s), ${errors.length} line(s) skipped.`
          : `Reloaded ${variables.length} variable(s).`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not reload: ${(err as Error).message}`
      );
    }
  }

  async exportDotenv(envId: string): Promise<void> {
    const environment = await this.storage.getEnvironment(envId);
    if (!environment) {
      return;
    }

    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export .env',
      filters: { 'Env files': ['env'] },
    });
    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from(toDotenv(environment.data), 'utf8')
    );
    void vscode.window.showInformationMessage(
      `Exported ${environment.data.length} variable(s).`
    );
  }

  async describeEnvironmentDelete(
    id: string
  ): Promise<{ name: string; varCount: number } | undefined> {
    const environment = await this.storage.getEnvironment(id);
    if (!environment) {
      return undefined;
    }
    return { name: environment.name, varCount: environment.data.length };
  }

  async setCollectionSettings(
    colId: string,
    settings: Collection['settings']
  ): Promise<void> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return;
    }
    collection.settings = settings;
    await this.storage.saveCollection(collection);
    this.notify();
  }

  async getCollection(colId: string): Promise<Collection | undefined> {
    return this.storage.getCollection(colId);
  }

  getExpanded(): string[] {
    return this.context.globalState.get<string[]>(EXPANDED_KEY, []);
  }

  async setExpanded(nodeId: string, expanded: boolean): Promise<void> {
    const current = new Set(this.getExpanded());
    if (expanded) {
      current.add(nodeId);
    } else {
      current.delete(nodeId);
    }
    await this.context.globalState.update(EXPANDED_KEY, [...current]);
  }

  setActiveRequest(requestId: string | null): void {
    this.activeEmitter.fire(requestId);
  }

  private notify(): void {
    this.emitter.fire();
  }

  async createCollection(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Collection name',
      placeHolder: 'My API',
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return;
    }
    const collection = await this.storage.createCollection(name.trim());
    await this.setExpanded(collection._id, true);
    this.notify();
  }

  async createFolder(colId: string, containerId: string): Promise<void> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Folder name',
      placeHolder: 'Users',
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return;
    }

    const folder: Folder = {
      _id: randomUUID(),
      name: name.trim(),
      containerId,
      created: new Date().toISOString(),
      sortNum: nextSortNum(siblingsOf(collection, containerId)),
    };

    collection.folders.push(folder);
    await this.storage.saveCollection(collection);
    await this.setExpanded(folder._id, true);
    if (containerId) {
      await this.setExpanded(containerId, true);
    }
    this.notify();
  }

  async createRequestIn(
    colId: string,
    containerId: string
  ): Promise<ApiRequest | undefined> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return undefined;
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Request name',
      value: 'New Request',
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return undefined;
    }

    const request = createEmptyRequest(randomUUID());
    request.name = name.trim();
    request.colId = colId;
    request.containerId = containerId;
    request.sortNum = nextSortNum(siblingsOf(collection, containerId));

    collection.requests.push(request);
    await this.storage.saveCollection(collection);
    if (containerId) {
      await this.setExpanded(containerId, true);
    }
    await this.setExpanded(colId, true);
    this.notify();
    return request;
  }

  async getRequest(
    colId: string,
    requestId: string
  ): Promise<ApiRequest | undefined> {
    const collection = await this.storage.getCollection(colId);
    return collection?.requests.find((r) => r._id === requestId);
  }

  async saveRequest(
    request: ApiRequest,
    alreadySaved: boolean
  ): Promise<ApiRequest | undefined> {
    if (alreadySaved && request.colId) {
      const collection = await this.storage.getCollection(request.colId);
      if (!collection) {
        return undefined;
      }
      const index = collection.requests.findIndex(
        (r) => r._id === request._id
      );
      if (index < 0) {
        return undefined;
      }
      request.modified = new Date().toISOString();
      collection.requests[index] = request;
      await this.storage.saveCollection(collection);
      this.notify();
      return request;
    }

    return this.saveScratchRequest(request);
  }

  private async saveScratchRequest(
    request: ApiRequest
  ): Promise<ApiRequest | undefined> {
    const collections = await this.storage.listCollections();

    const picks: (vscode.QuickPickItem & { id?: string })[] = [
      ...collections.map((c) => ({ label: c.colName, id: c._id })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) New Collection...' },
    ];

    const chosen = await vscode.window.showQuickPick(picks, {
      title: 'Save request to collection',
      placeHolder: 'Select a collection',
    });
    if (!chosen) {
      return undefined;
    }

    let collection: Collection | undefined;

    if (chosen.id) {
      collection = collections.find((c) => c._id === chosen.id);
    } else {
      const name = await vscode.window.showInputBox({
        prompt: 'Collection name',
        placeHolder: 'My API',
        validateInput: (value) =>
          value.trim() ? undefined : 'Name cannot be empty',
      });
      if (!name) {
        return undefined;
      }
      collection = await this.storage.createCollection(name.trim());
    }

    if (!collection) {
      return undefined;
    }

    const folderPicks: (vscode.QuickPickItem & { id?: string })[] = [
      { label: '$(root-folder) (collection root)', id: '' },
      ...collection.folders
        .sort((a, b) => a.sortNum - b.sortNum)
        .map((f) => ({ label: `$(folder) ${f.name}`, id: f._id })),
    ];

    let containerId = '';
    if (collection.folders.length > 0) {
      const folderChoice = await vscode.window.showQuickPick(folderPicks, {
        title: 'Save into folder',
        placeHolder: 'Select a folder',
      });
      if (!folderChoice) {
        return undefined;
      }
      containerId = folderChoice.id ?? '';
    }

    request.colId = collection._id;
    request.containerId = containerId;
    request.sortNum = nextSortNum(siblingsOf(collection, containerId));
    request.modified = new Date().toISOString();

    collection.requests.push(request);
    await this.storage.saveCollection(collection);
    await this.setExpanded(collection._id, true);
    if (containerId) {
      await this.setExpanded(containerId, true);
    }
    this.notify();
    return request;
  }

  async rename(
    colId: string,
    nodeId: string,
    kind: NodeKind
  ): Promise<ApiRequest | undefined> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return undefined;
    }

    const currentName =
      kind === 'collection'
        ? collection.colName
        : kind === 'folder'
        ? collection.folders.find((f) => f._id === nodeId)?.name
        : collection.requests.find((r) => r._id === nodeId)?.name;

    if (currentName === undefined) {
      return undefined;
    }

    const name = await vscode.window.showInputBox({
      prompt: `Rename ${kind}`,
      value: currentName,
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name || name.trim() === currentName) {
      return undefined;
    }

    let renamed: ApiRequest | undefined;

    if (kind === 'collection') {
      collection.colName = name.trim();
    } else if (kind === 'folder') {
      const folder = collection.folders.find((f) => f._id === nodeId);
      if (folder) {
        folder.name = name.trim();
      }
    } else {
      const request = collection.requests.find((r) => r._id === nodeId);
      if (request) {
        request.name = name.trim();
        request.modified = new Date().toISOString();
        renamed = request;
      }
    }

    await this.storage.saveCollection(collection);
    this.notify();
    return renamed;
  }

  async delete(
    colId: string,
    nodeId: string,
    kind: NodeKind
  ): Promise<string[]> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return [];
    }

    if (kind === 'collection') {
      const ids = collection.requests.map((r) => r._id);
      await this.storage.deleteCollection(colId);
      this.notify();
      return ids;
    }

    if (kind === 'folder') {
      if (!collection.folders.some((f) => f._id === nodeId)) {
        return [];
      }

      const folderIds = this.descendantFolderIds(collection, nodeId);
      const affected = collection.requests.filter((r) =>
        folderIds.has(r.containerId)
      );

      collection.folders = collection.folders.filter(
        (f) => !folderIds.has(f._id)
      );
      collection.requests = collection.requests.filter(
        (r) => !folderIds.has(r.containerId)
      );
      await this.storage.saveCollection(collection);
      this.notify();
      return affected.map((r) => r._id);
    }

    const request = collection.requests.find((r) => r._id === nodeId);
    if (!request) {
      return [];
    }

    collection.requests = collection.requests.filter((r) => r._id !== nodeId);
    await this.storage.saveCollection(collection);
    this.notify();
    return [nodeId];
  }

  async duplicate(
    colId: string,
    nodeId: string,
    kind: NodeKind
  ): Promise<void> {
    if (kind === 'collection') {
      const source = await this.storage.getCollection(colId);
      if (!source) {
        return;
      }
      const clone: Collection = JSON.parse(
        JSON.stringify(source)
      ) as Collection;
      clone._id = randomUUID();
      clone.colName = `${source.colName} copy`;
      clone.sortNum = source.sortNum + 1;

      const folderMap = new Map<string, string>();
      for (const folder of clone.folders) {
        const id = randomUUID();
        folderMap.set(folder._id, id);
        folder._id = id;
      }
      for (const folder of clone.folders) {
        if (folder.containerId) {
          folder.containerId = folderMap.get(folder.containerId) ?? '';
        }
      }
      for (const request of clone.requests) {
        request._id = randomUUID();
        request.colId = clone._id;
        if (request.containerId) {
          request.containerId = folderMap.get(request.containerId) ?? '';
        }
      }

      await this.storage.saveCollection(clone);
      this.notify();
      return;
    }

    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return;
    }

    if (kind === 'folder') {
      const source = collection.folders.find((f) => f._id === nodeId);
      if (!source) {
        return;
      }

      const ids = this.descendantFolderIds(collection, nodeId);
      const folderMap = new Map<string, string>();

      for (const id of ids) {
        folderMap.set(id, randomUUID());
      }

      for (const id of ids) {
        const original = collection.folders.find((f) => f._id === id);
        if (!original) {
          continue;
        }
        collection.folders.push({
          ...original,
          _id: folderMap.get(id)!,
          name: id === nodeId ? `${original.name} copy` : original.name,
          containerId:
            id === nodeId
              ? original.containerId
              : folderMap.get(original.containerId) ?? original.containerId,
          sortNum:
            id === nodeId ? original.sortNum + 1 : original.sortNum,
        });
      }

      for (const request of collection.requests.filter((r) =>
        ids.has(r.containerId)
      )) {
        collection.requests.push({
          ...JSON.parse(JSON.stringify(request)),
          _id: randomUUID(),
          containerId: folderMap.get(request.containerId)!,
        });
      }

      await this.storage.saveCollection(collection);
      this.notify();
      return;
    }

    const source = collection.requests.find((r) => r._id === nodeId);
    if (!source) {
      return;
    }

    const clone: ApiRequest = JSON.parse(
      JSON.stringify(source)
    ) as ApiRequest;
    clone._id = randomUUID();
    clone.name = `${source.name} copy`;
    clone.sortNum = source.sortNum + 1;
    clone.created = new Date().toISOString();
    clone.modified = clone.created;

    collection.requests.push(clone);
    this.renumber(collection, clone.containerId);
    await this.storage.saveCollection(collection);
    this.notify();
  }

  async moveCollection(
    colId: string,
    beforeColId: string | null
  ): Promise<void> {
    const all = await this.storage.listCollections();
    const moving = all.find((c) => c._id === colId);
    if (!moving) {
      return;
    }

    const others = all
      .filter((c) => c._id !== colId)
      .sort((a, b) => a.sortNum - b.sortNum);

    const index = beforeColId
      ? others.findIndex((c) => c._id === beforeColId)
      : others.length;

    const ordered = [...others];
    ordered.splice(index < 0 ? others.length : index, 0, moving);

    for (let i = 0; i < ordered.length; i++) {
      const next = (i + 1) * SORT_STEP;
      if (ordered[i].sortNum !== next) {
        ordered[i].sortNum = next;
        await this.storage.saveCollection(ordered[i]);
      }
    }

    this.notify();
  }

  async convertEnv(
    colId: string,
    to: 'embedded' | 'linked'
  ): Promise<void> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return;
    }

    const settings = collection.settings ?? { envMode: 'none' as const };

    if (to === 'embedded') {
      const all = await this.storage.listEnvironments();
      const linked = (settings.linkedEnvIds ?? [])
        .map((id) => all.find((e) => e._id === id))
        .filter((e): e is Environment => Boolean(e));

      const merged: Environment['data'] = [];
      for (const env of linked) {
        for (const variable of env.data) {
          const existing = merged.find((v) => v.name === variable.name);
          if (existing) {
            existing.value = variable.value;
          } else {
            merged.push({ ...variable });
          }
        }
      }

      collection.settings = {
        envMode: 'embedded',
        embeddedEnv: {
          name: linked.length === 1 ? linked[0].name : 'Embedded',
          data: merged,
        },
      };

      await this.storage.saveCollection(collection);
      this.notify();
      void vscode.window.showInformationMessage(
        `Copied ${merged.length} variable(s) into the collection.`
      );
      return;
    }

    const embedded = settings.embeddedEnv;
    if (!embedded) {
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Name for the new shared environment',
      value: embedded.name === 'Embedded' ? collection.colName : embedded.name,
      validateInput: (value) =>
        value.trim() ? undefined : 'Name cannot be empty',
    });
    if (!name) {
      return;
    }

    const environment = await this.storage.createEnvironment(name.trim());
    environment.data = embedded.data.map((v) => ({ ...v }));
    await this.storage.saveEnvironment(environment);

    collection.settings = {
      envMode: 'linked',
      linkedEnvIds: [environment._id],
    };

    await this.storage.saveCollection(collection);
    this.notify();
    void vscode.window.showInformationMessage(
      `Created environment "${environment.name}" with ${environment.data.length} variable(s).`
    );
  }

  async findVariableSource(
    name: string
  ): Promise<
    { kind: 'env'; envId: string } | { kind: 'file'; path: string } | null
  > {
    const environments = await this.storage.listEnvironments();
    for (const env of environments) {
      if (env.data.some((v) => v.name === name && !v.isDisabled)) {
        return env.dotenvPath
          ? { kind: 'file', path: env.dotenvPath }
          : { kind: 'env', envId: env._id };
      }
    }
    return null;
  }

  async moveNode(
    colId: string,
    nodeId: string,
    kind: NodeKind,
    targetContainerId: string,
    beforeNodeId: string | null,
    copy = false,
    targetColId?: string
  ): Promise<void> {
    const collection = await this.storage.getCollection(colId);
    if (!collection || kind === 'collection') {
      return;
    }

    const destColId = targetColId ?? colId;

    if (destColId !== colId) {
      await this.transferNode(
        collection,
        nodeId,
        kind,
        destColId,
        targetContainerId,
        copy
      );
      return;
    }

    if (copy) {
      const cloneId = await this.cloneWithin(
        collection,
        nodeId,
        kind,
        targetContainerId
      );
      if (!cloneId) {
        return;
      }
      await this.storage.saveCollection(collection);
      await this.moveNode(
        colId,
        cloneId,
        kind,
        targetContainerId,
        beforeNodeId,
        false
      );
      return;
    }

    if (kind === 'folder') {
      const moving = collection.folders.find((f) => f._id === nodeId);
      if (!moving) {
        return;
      }
      const descendants = this.descendantFolderIds(collection, nodeId);
      if (descendants.has(targetContainerId)) {
        void vscode.window.showWarningMessage(
          'A folder cannot be moved inside itself.'
        );
        return;
      }
      moving.containerId = targetContainerId;
      moving.sortNum = this.sortNumFor(
        collection,
        targetContainerId,
        beforeNodeId,
        nodeId
      );
    } else {
      const moving = collection.requests.find((r) => r._id === nodeId);
      if (!moving) {
        return;
      }
      moving.containerId = targetContainerId;
      moving.sortNum = this.sortNumFor(
        collection,
        targetContainerId,
        beforeNodeId,
        nodeId
      );
      moving.modified = new Date().toISOString();
    }

    await this.storage.saveCollection(collection);
    this.notify();
  }

  /**
   * Duplicates a node inside its own collection and returns the new id, so the
   * caller can position the clone. Unlike `duplicate`, the name is unchanged
   * because a drag-copy targets a different container.
   */
  private async cloneWithin(
    collection: Collection,
    nodeId: string,
    kind: NodeKind,
    targetContainerId: string
  ): Promise<string | null> {
    if (kind === 'request') {
      const request = collection.requests.find((r) => r._id === nodeId);
      if (!request) {
        return null;
      }
      const clone: ApiRequest = JSON.parse(
        JSON.stringify(request)
      ) as ApiRequest;
      clone._id = randomUUID();
      clone.containerId = targetContainerId;
      clone.sortNum = nextSortNum(siblingsOf(collection, targetContainerId));
      if (targetContainerId === request.containerId) {
        clone.name = `${request.name} copy`;
      }
      collection.requests.push(clone);
      return clone._id;
    }

    const source = collection.folders.find((f) => f._id === nodeId);
    if (!source) {
      return null;
    }

    const ids = this.descendantFolderIds(collection, nodeId);
    if (ids.has(targetContainerId)) {
      void vscode.window.showWarningMessage(
        'A folder cannot be copied inside itself.'
      );
      return null;
    }

    const map = new Map<string, string>();
    for (const id of ids) {
      map.set(id, randomUUID());
    }

    for (const id of ids) {
      const folder = collection.folders.find((f) => f._id === id);
      if (!folder) {
        continue;
      }
      collection.folders.push({
        ...folder,
        _id: map.get(id)!,
        name:
          id === nodeId && targetContainerId === folder.containerId
            ? `${folder.name} copy`
            : folder.name,
        containerId:
          id === nodeId
            ? targetContainerId
            : map.get(folder.containerId) ?? targetContainerId,
        sortNum:
          id === nodeId
            ? nextSortNum(siblingsOf(collection, targetContainerId))
            : folder.sortNum,
      });
    }

    for (const request of collection.requests.filter((r) =>
      ids.has(r.containerId)
    )) {
      const clone: ApiRequest = JSON.parse(
        JSON.stringify(request)
      ) as ApiRequest;
      clone._id = randomUUID();
      clone.containerId = map.get(request.containerId)!;
      collection.requests.push(clone);
    }

    return map.get(nodeId) ?? null;
  }

  /** Moves or copies a node into a different collection. */
  private async transferNode(
    source: Collection,
    nodeId: string,
    kind: NodeKind,
    destColId: string,
    targetContainerId: string,
    copy: boolean
  ): Promise<void> {
    const dest = await this.storage.getCollection(destColId);
    if (!dest) {
      return;
    }

    if (kind === 'request') {
      const request = source.requests.find((r) => r._id === nodeId);
      if (!request) {
        return;
      }
      const clone: ApiRequest = JSON.parse(
        JSON.stringify(request)
      ) as ApiRequest;
      clone._id = randomUUID();
      clone.colId = destColId;
      clone.containerId = targetContainerId;
      clone.sortNum = nextSortNum(siblingsOf(dest, targetContainerId));
      dest.requests.push(clone);

      if (!copy) {
        source.requests = source.requests.filter((r) => r._id !== nodeId);
        await this.storage.saveCollection(source);
      }
      await this.storage.saveCollection(dest);
      this.notify();
      return;
    }

    const ids = this.descendantFolderIds(source, nodeId);
    const map = new Map<string, string>();
    for (const id of ids) {
      map.set(id, randomUUID());
    }

    for (const id of ids) {
      const folder = source.folders.find((f) => f._id === id);
      if (!folder) {
        continue;
      }
      dest.folders.push({
        ...folder,
        _id: map.get(id)!,
        containerId:
          id === nodeId
            ? targetContainerId
            : map.get(folder.containerId) ?? targetContainerId,
        sortNum:
          id === nodeId
            ? nextSortNum(siblingsOf(dest, targetContainerId))
            : folder.sortNum,
      });
    }

    for (const request of source.requests.filter((r) =>
      ids.has(r.containerId)
    )) {
      const clone: ApiRequest = JSON.parse(
        JSON.stringify(request)
      ) as ApiRequest;
      clone._id = randomUUID();
      clone.colId = destColId;
      clone.containerId = map.get(request.containerId)!;
      dest.requests.push(clone);
    }

    if (!copy) {
      source.folders = source.folders.filter((f) => !ids.has(f._id));
      source.requests = source.requests.filter(
        (r) => !ids.has(r.containerId)
      );
      await this.storage.saveCollection(source);
    }

    await this.storage.saveCollection(dest);
    this.notify();
  }

  private sortNumFor(
    collection: Collection,
    containerId: string,
    beforeNodeId: string | null,
    excludeId: string
  ): number {
    const siblings = siblingsOf(collection, containerId)
      .filter((s) => s._id !== excludeId)
      .sort((a, b) => a.sortNum - b.sortNum);

    if (siblings.length === 0) {
      return SORT_STEP;
    }

    if (beforeNodeId === null) {
      return siblings[siblings.length - 1].sortNum + SORT_STEP;
    }

    const index = siblings.findIndex((s) => s._id === beforeNodeId);
    if (index < 0) {
      return siblings[siblings.length - 1].sortNum + SORT_STEP;
    }

    const after = siblings[index].sortNum;
    const before = index === 0 ? 0 : siblings[index - 1].sortNum;

    if (after - before > 1) {
      return Math.floor((before + after) / 2);
    }

    this.renumber(collection, containerId);
    return this.sortNumFor(collection, containerId, beforeNodeId, excludeId);
  }

  private renumber(collection: Collection, containerId: string): void {
    const siblings = siblingsOf(collection, containerId).sort(
      (a, b) => a.sortNum - b.sortNum
    );
    siblings.forEach((item, index) => {
      item.sortNum = (index + 1) * SORT_STEP;
    });
  }

  async describeDelete(
    colId: string,
    nodeId: string,
    kind: NodeKind
  ): Promise<
    { name: string; requestCount: number; folderCount: number } | undefined
  > {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return undefined;
    }

    if (kind === 'collection') {
      return {
        name: collection.colName,
        requestCount: collection.requests.length,
        folderCount: collection.folders.length,
      };
    }

    if (kind === 'folder') {
      const folder = collection.folders.find((f) => f._id === nodeId);
      if (!folder) {
        return undefined;
      }
      const ids = this.descendantFolderIds(collection, nodeId);
      return {
        name: folder.name,
        requestCount: collection.requests.filter((r) =>
          ids.has(r.containerId)
        ).length,
        folderCount: ids.size - 1,
      };
    }

    const request = collection.requests.find((r) => r._id === nodeId);
    if (!request) {
      return undefined;
    }
    return { name: request.name, requestCount: 0, folderCount: 0 };
  }

  private descendantFolderIds(
    collection: Collection,
    rootId: string
  ): Set<string> {
    const ids = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of collection.folders) {
        if (!ids.has(folder._id) && ids.has(folder.containerId)) {
          ids.add(folder._id);
          grew = true;
        }
      }
    }
    return ids;
  }

  refresh(): void {
    this.storage.invalidate();
    this.notify();
  }

  /* ---------- Import / Export ---------- */

  async importFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Import',
      filters: { 'JSON files': ['json'] },
    });
    if (!picked?.[0]) {
      return;
    }

    let raw: unknown;
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not read that file: ${(err as Error).message}`
      );
      return;
    }

    const telegraph = fromTelegraph(raw);
    if (telegraph) {
      telegraph.collection.sortNum = nextSort(
        await this.storage.listCollections()
      );
      await this.storage.saveCollection(telegraph.collection);
      for (const env of telegraph.environments) {
        env.sortNum = nextSort(await this.storage.listEnvironments());
        await this.storage.saveEnvironment(env);
      }
      await this.setExpanded(telegraph.collection._id, true);
      this.notify();
      void vscode.window.showInformationMessage(
        `Imported "${telegraph.collection.colName}" (${telegraph.collection.requests.length} requests, ${telegraph.environments.length} environments).`
      );
      return;
    }

    const postmanEnv = fromPostmanEnvironment(raw);
    if (postmanEnv) {
      postmanEnv.sortNum = nextSort(await this.storage.listEnvironments());
      await this.storage.saveEnvironment(postmanEnv);
      this.notify();
      void vscode.window.showInformationMessage(
        `Imported environment "${postmanEnv.name}" (${postmanEnv.data.length} variables).`
      );
      return;
    }

    const collection =
      fromPostmanCollection(raw) ?? fromOpenApi(raw);
    if (collection) {
      collection.sortNum = nextSort(await this.storage.listCollections());
      await this.storage.saveCollection(collection);
      await this.setExpanded(collection._id, true);
      this.notify();
      void vscode.window.showInformationMessage(
        `Imported "${collection.colName}" (${collection.requests.length} requests).`
      );
      return;
    }

    void vscode.window.showErrorMessage(
      'Unrecognized file. Supported: Telegraph export, Postman collection or environment (v2.1), OpenAPI/Swagger JSON.'
    );
  }

  async importCurl(): Promise<ApiRequest | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: 'Paste a cURL command',
      placeHolder: "curl -X POST 'https://api.example.com' -d '{}'",
      ignoreFocusOut: true,
    });
    if (!input) {
      return undefined;
    }

    const request = parseCurl(input);
    if (!request) {
      void vscode.window.showErrorMessage(
        'That does not look like a valid cURL command.'
      );
      return undefined;
    }
    return request;
  }

  async exportCollection(colId: string): Promise<void> {
    const collection = await this.storage.getCollection(colId);
    if (!collection) {
      return;
    }

    const format = await vscode.window.showQuickPick(
      [
        {
          label: 'Telegraph',
          detail: 'One file containing the collection and its environments',
          id: 'telegraph',
        },
        {
          label: 'Postman v2.1',
          detail: 'Two files: collection and environment',
          id: 'postman',
        },
      ],
      { title: 'Export format', placeHolder: 'Select a format' }
    );
    if (!format) {
      return;
    }

    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Export here',
    });
    if (!folder?.[0]) {
      return;
    }

    const safe = collection.colName.replace(/[^\w.-]+/g, '-');
    const written: string[] = [];

    const write = async (name: string, data: unknown): Promise<void> => {
      const uri = vscode.Uri.joinPath(folder[0], name);
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(JSON.stringify(data, null, 2), 'utf8')
      );
      written.push(name);
    };

    const environments = await this.relatedEnvironments(collection);

    if (format.id === 'telegraph') {
      await write(`${safe}.telegraph.json`, toTelegraph(collection, environments));
    } else {
      await write(
        `${safe}.postman_collection.json`,
        toPostmanCollection(collection)
      );
      for (const env of environments) {
        const envSafe = env.name.replace(/[^\w.-]+/g, '-');
        await write(
          `${envSafe}.postman_environment.json`,
          toPostmanEnvironment(env)
        );
      }
      if (environments.length === 0) {
        void vscode.window.showWarningMessage(
          'No environment is linked to this collection, so only the collection file was written.'
        );
      }
    }

    void vscode.window.showInformationMessage(
      `Exported ${written.length} file(s): ${written.join(', ')}`
    );
  }

  private async relatedEnvironments(
    collection: Collection
  ): Promise<Environment[]> {
    const all = await this.storage.listEnvironments();
    const settings = collection.settings;
    const out: Environment[] = [];

    if (settings?.envMode === 'linked') {
      for (const id of settings.linkedEnvIds ?? []) {
        const found = all.find((e) => e._id === id);
        if (found) {
          out.push(found);
        }
      }
    }

    if (settings?.envMode === 'embedded' && settings.embeddedEnv) {
      out.push({
        _id: randomUUID(),
        name: settings.embeddedEnv.name,
        default: false,
        sortNum: 0,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        data: settings.embeddedEnv.data,
      });
    }

    if (out.length === 0) {
      const active = all.find((e) => e._id === this.getActiveEnvId());
      if (active) {
        out.push(active);
      }
    }

    return out;
  }

  async exportEnvironment(envId: string): Promise<void> {
    const environment = await this.storage.getEnvironment(envId);
    if (!environment) {
      return;
    }

    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Export here',
    });
    if (!folder?.[0]) {
      return;
    }

    const safe = environment.name.replace(/[^\w.-]+/g, '-');
    const name = `${safe}.postman_environment.json`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder[0], name),
      Buffer.from(
        JSON.stringify(toPostmanEnvironment(environment), null, 2),
        'utf8'
      )
    );
    void vscode.window.showInformationMessage(`Exported ${name}`);
  }

  async copyAsCurl(colId: string, requestId: string): Promise<void> {
    const request = await this.getRequest(colId, requestId);
    if (!request) {
      return;
    }
    const scope = await this.scopeFor(colId);
    await vscode.env.clipboard.writeText(
      toCurl(resolveRequest(request, scope))
    );
    void vscode.window.showInformationMessage('cURL command copied.');
  }
}
