import { el, clear } from './dom';
import { confirmDialog } from './components/modal';
import type {
  Collection,
  Folder,
  ApiRequest,
  HistoryEntry,
} from '../core/types';
import type { HostToSidebar, NodeKind, SidebarToHost } from '../core/messages';

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarToHost): void;
};

const vscode = acquireVsCodeApi();

let dragged: {
  colId: string;
  nodeId: string;
  kind: NodeKind;
  containerId: string;
} | null = null;

let copyMode = false;
let hoverExpandTimer: number | undefined;
let hoverExpandId: string | null = null;
let draggedCollection: string | null = null;
let collectionDropBefore: string | null = null;

let dropTarget: {
  node: { colId: string; nodeId: string; kind: NodeKind; containerId: string };
  zone: 'before' | 'after' | 'inside';
} | null = null;

/**
 * Scrolls the sidebar while a drag hovers near its top or bottom edge, so a
 * drop target outside the current view can still be reached.
 */
const EDGE = 48;
const MAX_STEP = 14;
let scrollTimer: number | undefined;
let scrollStep = 0;

function scrollTarget(): HTMLElement {
  return document.scrollingElement as HTMLElement;
}

function updateAutoScroll(clientY: number): void {
  const height = window.innerHeight;
  let step = 0;

  if (clientY < EDGE) {
    step = -Math.ceil(((EDGE - clientY) / EDGE) * MAX_STEP);
  } else if (clientY > height - EDGE) {
    step = Math.ceil(((clientY - (height - EDGE)) / EDGE) * MAX_STEP);
  }

  scrollStep = step;

  if (step === 0) {
    stopAutoScroll();
    return;
  }

  if (scrollTimer === undefined) {
    scrollTimer = window.setInterval(() => {
      if (scrollStep === 0) {
        stopAutoScroll();
        return;
      }
      scrollTarget().scrollTop += scrollStep;
    }, 16);
  }
}

function stopAutoScroll(): void {
  if (scrollTimer !== undefined) {
    window.clearInterval(scrollTimer);
    scrollTimer = undefined;
  }
  scrollStep = 0;
}

document.addEventListener('dragover', (event) => {
  if (dragged || draggedCollection) {
    updateAutoScroll(event.clientY);
  }
});

document.addEventListener('drop', stopAutoScroll);
document.addEventListener('dragend', stopAutoScroll);
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) {
    stopAutoScroll();
  }
});

function clearDropMarkers(): void {
  document
    .querySelectorAll('.drop-before, .drop-after, .drop-inside')
    .forEach((node) => {
      node.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });
}

const METHOD_LABEL: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DEL',
  HEAD: 'HEAD',
  OPTIONS: 'OPT',
};

class Tree {
  private collections: Collection[] = [];
  private envNames: Record<string, string> = {};
  private expanded = new Set<string>();
  private activeRequestId: string | null = null;
  private filter = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly searchInput: HTMLInputElement
  ) {}

  setData(
    collections: Collection[],
    expanded: string[],
    envNames: Record<string, string>
  ): void {
    this.collections = collections;
    this.expanded = new Set(expanded);
    this.envNames = envNames;
    this.render();
  }

  setActive(requestId: string | null): void {
    this.activeRequestId = requestId;
    this.render();
  }

  setFilter(value: string): void {
    this.filter = value.trim().toLowerCase();
    this.render();
  }

  private matches(request: ApiRequest): boolean {
    if (!this.filter) {
      return true;
    }
    return (
      request.name.toLowerCase().includes(this.filter) ||
      request.url.toLowerCase().includes(this.filter)
    );
  }

  private folderHasMatch(collection: Collection, folderId: string): boolean {
    if (!this.filter) {
      return true;
    }
    const requests = collection.requests.filter(
      (r) => r.containerId === folderId
    );
    if (requests.some((r) => this.matches(r))) {
      return true;
    }
    return collection.folders
      .filter((f) => f.containerId === folderId)
      .some((f) => this.folderHasMatch(collection, f._id));
  }

  private collectionHasMatch(collection: Collection): boolean {
    if (!this.filter) {
      return true;
    }
    return (
      collection.requests.some((r) => this.matches(r)) ||
      collection.colName.toLowerCase().includes(this.filter)
    );
  }

  private isExpanded(id: string): boolean {
    return this.filter ? true : this.expanded.has(id);
  }

  private toggle(id: string): void {
    if (this.filter) {
      return;
    }
    const next = !this.expanded.has(id);
    if (next) {
      this.expanded.add(id);
    } else {
      this.expanded.delete(id);
    }
    vscode.postMessage({ type: 'toggle', nodeId: id, expanded: next });
    this.render();
  }

  render(): void {
    clear(this.container);

    this.searchInput.parentElement?.classList.toggle(
      'hidden',
      this.collections.length === 0
    );

    if (this.collections.length === 0) {
      this.container.append(
        el('div', { class: 'tree-empty' }, [
          el('p', {}, ['No collections yet.']),
          el('p', { class: 'tree-empty-hint' }, [
            'Create a collection to save and organize requests.',
          ]),
        ])
      );
      return;
    }

    const visible = this.collections.filter((c) =>
      this.collectionHasMatch(c)
    );

    if (visible.length === 0) {
      this.container.append(
        el('div', { class: 'tree-empty' }, [
          el('p', {}, ['No requests match your search.']),
        ])
      );
      return;
    }

    for (const collection of visible) {
      this.container.append(this.renderCollection(collection));
    }
  }

  private renderCollection(collection: Collection): HTMLElement {
    const expanded = this.isExpanded(collection._id);

    const row = this.row({
      depth: 0,
      expanded,
      hasChildren:
        collection.folders.length > 0 || collection.requests.length > 0,
      icon: 'collection',
      label: collection.colName,
      rowClass: 'tree-collection',
      onToggle: () => this.toggle(collection._id),
      onClick: () => this.toggle(collection._id),
      menu: [
        {
          label: 'New Request',
          run: () =>
            vscode.postMessage({
              type: 'newRequestIn',
              colId: collection._id,
              containerId: '',
            }),
        },
        {
          label: 'New Folder',
          run: () =>
            vscode.postMessage({
              type: 'newFolder',
              colId: collection._id,
              containerId: '',
            }),
        },
        {
          label: 'Environment...',
          run: () =>
            vscode.postMessage({
              type: 'openCollectionEnv',
              colId: collection._id,
            }),
        },
        {
          label: 'Export...',
          run: () =>
            vscode.postMessage({
              type: 'exportCollection',
              colId: collection._id,
            }),
        },
        {
          label: 'Duplicate',
          run: () =>
            vscode.postMessage({
              type: 'duplicate',
              colId: collection._id,
              nodeId: collection._id,
              kind: 'collection',
            }),
        },
        {
          label: 'Rename',
          run: () =>
            vscode.postMessage({
              type: 'rename',
              colId: collection._id,
              nodeId: collection._id,
              kind: 'collection',
            }),
        },
        {
          label: 'Delete',
          danger: true,
          run: () =>
            vscode.postMessage({
              type: 'requestDeleteInfo',
              colId: collection._id,
              nodeId: collection._id,
              kind: 'collection',
            }),
        },
      ],
    });

    this.makeCollectionDraggable(row, collection._id);

    const wrap = el('div', { class: 'tree-node' }, [row]);

    if (expanded) {
      const badge = this.envBadgeRow(collection);
      if (badge) {
        wrap.append(badge);
      }
      wrap.append(this.renderChildren(collection, '', 1));
    }

    return wrap;
  }

  private makeCollectionDraggable(row: HTMLElement, colId: string): void {
    row.draggable = true;

    row.addEventListener('dragstart', (event) => {
      draggedCollection = colId;
      row.classList.add('dragging');
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', colId);
      }
    });

    row.addEventListener('dragend', () => {
      draggedCollection = null;
      stopAutoScroll();
      row.classList.remove('dragging');
      clearDropMarkers();
    });

    row.addEventListener('dragover', (event) => {
      // A request or folder dropped on a collection row lands at its root.
      if (dragged) {
        event.preventDefault();
        event.stopPropagation();
        clearDropMarkers();
        row.classList.add('drop-inside');
        dropTarget = {
          node: {
            colId,
            nodeId: '',
            kind: 'collection',
            containerId: '',
          },
          zone: 'inside',
        };

        if (!this.isExpanded(colId) && hoverExpandId !== colId) {
          hoverExpandId = colId;
          window.clearTimeout(hoverExpandTimer);
          hoverExpandTimer = window.setTimeout(() => {
            this.expandForDrop(colId);
          }, 600);
        }
        return;
      }

      if (!draggedCollection || draggedCollection === colId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      clearDropMarkers();
      row.classList.add(after ? 'drop-after' : 'drop-before');
      collectionDropBefore = after ? null : colId;
    });

    row.addEventListener('drop', (event) => {
      if (dragged && dropTarget) {
        event.preventDefault();
        event.stopPropagation();
        const source = dragged;
        const copy =
          copyMode || event.ctrlKey || event.altKey || event.metaKey;
        dragged = null;
        dropTarget = null;
        copyMode = false;
        window.clearTimeout(hoverExpandTimer);
        hoverExpandId = null;
        clearDropMarkers();
        vscode.postMessage({
          type: 'move',
          colId: source.colId,
          nodeId: source.nodeId,
          kind: source.kind,
          targetColId: colId,
          targetContainerId: '',
          beforeNodeId: null,
          copy,
        });
        return;
      }

      if (!draggedCollection) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const source = draggedCollection;
      const before = collectionDropBefore;
      draggedCollection = null;
      collectionDropBefore = null;
      clearDropMarkers();
      vscode.postMessage({
        type: 'moveCollection',
        colId: source,
        beforeColId: before,
      });
    });
  }

  private expandForDrop(nodeId: string): void {
    this.expanded.add(nodeId);
    vscode.postMessage({ type: 'toggle', nodeId, expanded: true });
    this.render();
  }

  private envBadgeRow(collection: Collection): HTMLElement | null {
    const settings = collection.settings;
    const mode = settings?.envMode ?? 'none';

    const label =
      mode === 'none'
        ? 'Not set'
        : mode === 'embedded'
        ? 'Embedded'
        : (() => {
            const names = (settings?.linkedEnvIds ?? [])
              .map((id) => this.envNames[id])
              .filter(Boolean);
            return names.length
              ? `Linked · ${names.join(', ')}`
              : 'Linked · (none)';
          })();

    const row = el('div', { class: 'tree-row env-badge-row' }, [
      el('span', { class: 'tree-indent' }),
      el('span', { class: 'tree-chevron-spacer' }),
      el('span', { class: `env-chip mode-${mode}` }, ['Env']),
      el('span', { class: 'env-badge-label', title: label }, [label]),
    ]);

    row.addEventListener('click', () =>
      vscode.postMessage({
        type: 'openCollectionEnv',
        colId: collection._id,
      })
    );

    return row;
  }

  private renderChildren(
    collection: Collection,
    containerId: string,
    depth: number
  ): HTMLElement {
    const group = el('div', { class: 'tree-children' });

    const folders = collection.folders
      .filter((f) => f.containerId === containerId)
      .filter((f) => this.folderHasMatch(collection, f._id))
      .sort((a, b) => a.sortNum - b.sortNum);

    for (const folder of folders) {
      group.append(this.renderFolder(collection, folder, depth));
    }

    const requests = collection.requests
      .filter((r) => r.containerId === containerId)
      .filter((r) => this.matches(r))
      .sort((a, b) => a.sortNum - b.sortNum);

    for (const request of requests) {
      group.append(this.renderRequest(collection, request, depth));
    }

    if (folders.length === 0 && requests.length === 0) {
      const indents: HTMLElement[] = [];
      for (let level = 0; level < depth; level++) {
        indents.push(el('span', { class: 'tree-indent' }));
      }
      group.append(
        el('div', { class: 'tree-row tree-placeholder' }, [
          ...indents,
          el('span', { class: 'tree-chevron-spacer' }),
          el('span', { class: 'tree-label' }, ['Empty']),
        ])
      );
    }

    return group;
  }

  private renderFolder(
    collection: Collection,
    folder: Folder,
    depth: number
  ): HTMLElement {
    const expanded = this.isExpanded(folder._id);

    const row = this.row({
      depth,
      expanded,
      hasChildren: true,
      icon: 'folder',
      label: folder.name,
      onToggle: () => this.toggle(folder._id),
      onClick: () => this.toggle(folder._id),
      menu: [
        {
          label: 'New Request',
          run: () =>
            vscode.postMessage({
              type: 'newRequestIn',
              colId: collection._id,
              containerId: folder._id,
            }),
        },
        {
          label: 'New Folder',
          run: () =>
            vscode.postMessage({
              type: 'newFolder',
              colId: collection._id,
              containerId: folder._id,
            }),
        },
        {
          label: 'Duplicate',
          run: () =>
            vscode.postMessage({
              type: 'duplicate',
              colId: collection._id,
              nodeId: folder._id,
              kind: 'folder',
            }),
        },
        {
          label: 'Rename',
          run: () =>
            vscode.postMessage({
              type: 'rename',
              colId: collection._id,
              nodeId: folder._id,
              kind: 'folder',
            }),
        },
        {
          label: 'Delete',
          danger: true,
          run: () =>
            vscode.postMessage({
              type: 'requestDeleteInfo',
              colId: collection._id,
              nodeId: folder._id,
              kind: 'folder',
            }),
        },
      ],
    });

    this.makeDraggable(
      row,
      {
        colId: collection._id,
        nodeId: folder._id,
        kind: 'folder',
        containerId: folder.containerId,
      },
      true
    );

    const wrap = el('div', { class: 'tree-node' }, [row]);
    if (expanded) {
      wrap.append(this.renderChildren(collection, folder._id, depth + 1));
    }
    return wrap;
  }

  private renderRequest(
    collection: Collection,
    request: ApiRequest,
    depth: number
  ): HTMLElement {
    const row = this.row({
      depth,
      expanded: false,
      hasChildren: false,
      method: request.method,
      label: request.name,
      active: request._id === this.activeRequestId,
      onClick: () =>
        vscode.postMessage({
          type: 'openRequest',
          colId: collection._id,
          requestId: request._id,
        }),
      menu: [
        {
          label: 'Copy as cURL',
          run: () =>
            vscode.postMessage({
              type: 'copyCurl',
              colId: collection._id,
              requestId: request._id,
            }),
        },
        {
          label: 'Duplicate',
          run: () =>
            vscode.postMessage({
              type: 'duplicate',
              colId: collection._id,
              nodeId: request._id,
              kind: 'request',
            }),
        },
        {
          label: 'Rename',
          run: () =>
            vscode.postMessage({
              type: 'rename',
              colId: collection._id,
              nodeId: request._id,
              kind: 'request',
            }),
        },
        {
          label: 'Delete',
          danger: true,
          run: () =>
            vscode.postMessage({
              type: 'requestDeleteInfo',
              colId: collection._id,
              nodeId: request._id,
              kind: 'request',
            }),
        },
      ],
    });

    this.makeDraggable(
      row,
      {
        colId: collection._id,
        nodeId: request._id,
        kind: 'request',
        containerId: request.containerId,
      },
      false
    );

    return el('div', { class: 'tree-node' }, [row]);
  }

  private makeDraggable(
    row: HTMLElement,
    node: { colId: string; nodeId: string; kind: NodeKind; containerId: string },
    acceptsChildren: boolean
  ): void {
    row.draggable = true;

    row.addEventListener('dragstart', (event) => {
      dragged = node;
      copyMode = event.ctrlKey || event.altKey || event.metaKey;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', node.nodeId);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
      }
      event.stopPropagation();
    });

    row.addEventListener('dragend', () => {
      dragged = null;
      copyMode = false;
      stopAutoScroll();
      window.clearTimeout(hoverExpandTimer);
      hoverExpandId = null;
      row.classList.remove('dragging');
      clearDropMarkers();
    });

    row.addEventListener('dragover', (event) => {
      if (!dragged || dragged.nodeId === node.nodeId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      // Hovering a collapsed container during a drag expands it so you can
      // drop inside without releasing first.
      if (acceptsChildren && !this.isExpanded(node.nodeId)) {
        if (hoverExpandId !== node.nodeId) {
          hoverExpandId = node.nodeId;
          window.clearTimeout(hoverExpandTimer);
          hoverExpandTimer = window.setTimeout(() => {
            this.expandForDrop(node.nodeId);
          }, 600);
        }
      }

      const rect = row.getBoundingClientRect();
      const offset = event.clientY - rect.top;
      const zone = acceptsChildren
        ? offset < rect.height * 0.25
          ? 'before'
          : offset > rect.height * 0.75
          ? 'after'
          : 'inside'
        : offset < rect.height / 2
        ? 'before'
        : 'after';

      clearDropMarkers();
      row.classList.add(`drop-${zone}`);
      dropTarget = { node, zone };
    });

    row.addEventListener('drop', (event) => {
      if (!dragged || !dropTarget) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const { node: target, zone } = dropTarget;
      const source = dragged;
      window.clearTimeout(hoverExpandTimer);
      hoverExpandId = null;
      clearDropMarkers();
      dragged = null;
      dropTarget = null;
      copyMode = false;

      const copy = copyMode || event.ctrlKey || event.altKey || event.metaKey;

      vscode.postMessage({
        type: 'move',
        colId: source.colId,
        nodeId: source.nodeId,
        kind: source.kind,
        targetColId: target.colId,
        targetContainerId:
          zone === 'inside' ? target.nodeId : target.containerId,
        beforeNodeId: zone === 'before' ? target.nodeId : null,
        copy,
      });
    });
  }

  private row(config: {
    depth: number;
    expanded: boolean;
    hasChildren: boolean;
    label: string;
    icon?: 'folder' | 'collection';
    rowClass?: string;
    method?: string;
    active?: boolean;
    onToggle?: () => void;
    onClick: () => void;
    menu: { label: string; run: () => void; danger?: boolean }[];
  }): HTMLElement {
    const children: (Node | string)[] = [];

    for (let level = 0; level < config.depth; level++) {
      children.push(el('span', { class: 'tree-indent' }));
    }

    if (config.hasChildren) {
      const chevron = el('span', {
        class: `tree-chevron ${config.expanded ? 'expanded' : ''}`.trim(),
      });
      chevron.addEventListener('click', (event) => {
        event.stopPropagation();
        config.onToggle?.();
      });
      children.push(chevron);
    } else {
      children.push(el('span', { class: 'tree-chevron-spacer' }));
    }

    if (config.method) {
      children.push(
        el(
          'span',
          { class: 'tree-method', 'data-method': config.method },
          [METHOD_LABEL[config.method] ?? config.method]
        )
      );
    } else if (config.icon === 'collection') {
      children.push(el('span', { class: 'tree-collection-icon' }));
    } else if (config.icon === 'folder') {
      children.push(el('span', { class: 'tree-folder-icon' }));
    }

    children.push(el('span', { class: 'tree-label' }, [config.label]));

    const menuButton = el('button', {
      class: 'tree-menu-btn',
      type: 'button',
      title: 'More actions',
    }, ['⋯']) as HTMLButtonElement;

    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      showContextMenu(menuButton, config.menu);
    });

    children.push(menuButton);

    const row = el(
      'div',
      {
        class: `tree-row ${config.rowClass ?? ''} ${
          config.active ? 'active' : ''
        }`.replace(/\s+/g, ' ').trim(),
      },
      children
    );

    row.addEventListener('click', () => config.onClick());
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(menuButton, config.menu);
    });

    return row;
  }
}

let activeMenu: HTMLElement | null = null;

function closeMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
}

document.addEventListener('click', closeMenu);
window.addEventListener('blur', closeMenu);

function showContextMenu(
  anchor: HTMLElement,
  items: { label: string; run: () => void; danger?: boolean }[]
): void {
  closeMenu();

  const menu = el('div', { class: 'ctx-menu' });

  for (const item of items) {
    const entry = el(
      'div',
      { class: `ctx-item ${item.danger ? 'danger' : ''}`.trim() },
      [item.label]
    );
    entry.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      item.run();
    });
    menu.append(entry);
  }

  document.body.append(menu);
  activeMenu = menu;

  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const top =
    rect.bottom + height > window.innerHeight
      ? Math.max(4, rect.top - height)
      : rect.bottom + 2;

  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4))}px`;
}

async function promptDelete(info: {
  colId: string;
  nodeId: string;
  kind: NodeKind;
  name: string;
  requestCount: number;
  folderCount: number;
}): Promise<void> {
  const parts: string[] = [];
  if (info.folderCount > 0) {
    parts.push(`${info.folderCount} folder${info.folderCount === 1 ? '' : 's'}`);
  }
  if (info.requestCount > 0) {
    parts.push(
      `${info.requestCount} request${info.requestCount === 1 ? '' : 's'}`
    );
  }

  const confirmed = await confirmDialog({
    title: `Delete ${info.kind}`,
    message: `Delete "${info.name}"?`,
    detail: parts.length
      ? `${parts.join(' and ')} inside will also be deleted. This cannot be undone.`
      : 'This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });

  if (confirmed) {
    vscode.postMessage({
      type: 'delete',
      colId: info.colId,
      nodeId: info.nodeId,
      kind: info.kind,
    });
  }
}

class EnvList {
  private environments: {
    id: string;
    name: string;
    varCount: number;
    dotenv?: boolean;
  }[] = [];
  private activeEnvId: string | null = null;
  private collections: {
    colId: string;
    colName: string;
    mode: string;
    linkedNames?: string[];
    dotenv?: boolean;
  }[] = [];

  constructor(private readonly container: HTMLElement) {}

  setData(
    environments: {
      id: string;
      name: string;
      varCount: number;
      dotenv?: boolean;
    }[],
    activeEnvId: string | null,
    collections: {
      colId: string;
      colName: string;
      mode: string;
      linkedNames?: string[];
      dotenv?: boolean;
    }[]
  ): void {
    this.environments = environments;
    this.activeEnvId = activeEnvId;
    this.collections = collections;
    this.render();
  }

  private render(): void {
    clear(this.container);

    this.container.append(
      el('div', { class: 'env-section-title' }, ['Environments'])
    );

    if (this.environments.length === 0) {
      this.container.append(
        el('div', { class: 'tree-empty' }, [
          el('p', {}, ['No environments yet.']),
          el('p', { class: 'tree-empty-hint' }, [
            'Create one to share {{variables}} across collections.',
          ]),
        ])
      );
    }

    for (const env of this.environments) {
      const active = env.id === this.activeEnvId;

      const radio = el('span', {
        class: `env-radio ${active ? 'on' : ''}`.trim(),
        title: active ? 'Active environment' : 'Set as active',
      });
      radio.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({
          type: 'activateEnv',
          envId: active ? null : env.id,
        });
      });

      const menuBtn = el('button', {
        class: 'tree-menu-btn',
        type: 'button',
        title: 'More actions',
      }, ['⋯']) as HTMLButtonElement;

      const menu = [
        {
          label: 'Export as Postman...',
          run: () => vscode.postMessage({ type: 'exportEnv', envId: env.id }),
        },
        {
          label: 'Export as .env...',
          run: () =>
            vscode.postMessage({ type: 'exportDotenv', envId: env.id }),
        },
        ...(env.dotenv
          ? [
              {
                label: 'Reload from .env file',
                run: () =>
                  vscode.postMessage({
                    type: 'reloadDotenv',
                    envId: env.id,
                  }),
              },
            ]
          : []),
        {
          label: 'Rename',
          run: () => vscode.postMessage({ type: 'renameEnv', envId: env.id }),
        },
        {
          label: 'Delete',
          danger: true,
          run: () =>
            vscode.postMessage({
              type: 'requestEnvDeleteInfo',
              envId: env.id,
            }),
        },
      ];

      menuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        showContextMenu(menuBtn, menu);
      });

      const row = el(
        'div',
        { class: `tree-row env-row ${active ? 'active' : ''}`.trim() },
        [
          radio,
          el('span', { class: 'tree-label' }, [env.name]),
          env.dotenv
            ? el('span', { class: 'env-dotenv-chip', title: 'Linked to a .env file' }, ['.env'])
            : el('span'),
          el('span', { class: 'env-count' }, [String(env.varCount)]),
          menuBtn,
        ]
      );

      row.addEventListener('click', () =>
        vscode.postMessage({ type: 'openEnv', envId: env.id })
      );
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showContextMenu(menuBtn, menu);
      });

      this.container.append(row);
    }

    if (this.collections.length > 0) {
      this.container.append(
        el('div', { class: 'env-section-title spaced' }, [
          'Collection Environments',
        ])
      );

      for (const col of this.collections) {
        const row = el('div', { class: 'tree-row' }, [
          el('span', { class: 'tree-folder-icon' }),
          el('span', { class: 'tree-label' }, [col.colName]),
          el('span', { class: `env-mode-badge mode-${col.mode}` }, [col.mode]),
          col.linkedNames && col.linkedNames.length
            ? el('span', { class: 'env-linked-names' }, [
                col.linkedNames.join(', '),
              ])
            : el('span'),
        ]);
        row.addEventListener('click', () =>
          vscode.postMessage({
            type: 'openCollectionEnv',
            colId: col.colId,
          })
        );
        this.container.append(row);
      }
    }
  }
}

async function promptEnvDelete(info: {
  envId: string;
  name: string;
  varCount: number;
}): Promise<void> {
  const confirmed = await confirmDialog({
    title: 'Delete environment',
    message: `Delete "${info.name}"?`,
    detail: info.varCount
      ? `${info.varCount} variable${info.varCount === 1 ? '' : 's'} will be deleted. This cannot be undone.`
      : 'This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });

  if (confirmed) {
    vscode.postMessage({ type: 'deleteEnv', envId: info.envId });
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

class HistoryList {
  private entries: HistoryEntry[] = [];

  constructor(private readonly container: HTMLElement) {}

  setData(entries: HistoryEntry[]): void {
    this.entries = entries;
    this.render();
  }

  private render(): void {
    clear(this.container);

    if (this.entries.length === 0) {
      this.container.append(
        el('div', { class: 'tree-empty' }, [
          el('p', {}, ['No activity yet.']),
          el('p', { class: 'tree-empty-hint' }, [
            'Ad-hoc requests you send appear here. Collection requests are not tracked.',
          ])
        ])
      );
      return;
    }

    for (const entry of this.entries) {
      const failed = entry.status === 0;
      const statusClass = failed
        ? 'hist-fail'
        : entry.status >= 400
        ? 'hist-error'
        : entry.status >= 300
        ? 'hist-redirect'
        : 'hist-ok';

      const row = el('div', { class: 'tree-row hist-row' }, [
        el('span', { class: 'tree-method', 'data-method': entry.method }, [
          METHOD_LABEL[entry.method] ?? entry.method,
        ]),
        el('span', { class: 'tree-label hist-url', title: entry.url }, [
          entry.name && entry.name !== 'New Request' ? entry.name : entry.url,
        ]),
        (entry.runCount ?? 1) > 1
          ? el('span', {
              class: 'hist-runs',
              title: `Run ${entry.runCount} times`,
            }, [`×${entry.runCount}`])
          : el('span'),
        el('span', { class: `hist-status ${statusClass}` }, [
          failed ? 'ERR' : String(entry.status),
        ]),
      ]);

      const runs = entry.runCount ?? 1;
      row.title = [
        `${entry.method} ${entry.url}`,
        failed
          ? entry.error ?? 'Failed'
          : `${entry.status} ${entry.statusText}`,
        `${entry.durationMs}ms · last run ${relativeTime(entry.at)}`,
        runs > 1
          ? `Run ${runs} times, first ${relativeTime(entry.firstRunAt ?? entry.at)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      row.addEventListener('click', () =>
        vscode.postMessage({ type: 'replayHistory', entryId: entry._id })
      );

      this.container.append(row);
    }
  }
}

const root = document.getElementById('tree');
const search = document.getElementById('search') as HTMLInputElement | null;
const newRequestBtn = document.getElementById('new-request');
const newCollectionBtn = document.getElementById('new-collection');

const envRoot = document.getElementById('env-list');
const histRoot = document.getElementById('hist-list');
const tabHist = document.getElementById('tab-hist');
const histPane = document.getElementById('pane-hist');
const tabCollections = document.getElementById('tab-collections');
const tabEnv = document.getElementById('tab-env');
const collectionsPane = document.getElementById('pane-collections');
const envPane = document.getElementById('pane-env');
const newEnvBtn = document.getElementById('new-env');

if (root && search && envRoot) {
  const tree = new Tree(root, search);
  const envList = new EnvList(envRoot);
  const histList = histRoot ? new HistoryList(histRoot) : null;

  const selectPane = (name: 'collections' | 'env' | 'hist'): void => {
    collectionsPane?.classList.toggle('hidden', name !== 'collections');
    envPane?.classList.toggle('hidden', name !== 'env');
    histPane?.classList.toggle('hidden', name !== 'hist');
    tabCollections?.classList.toggle('active', name === 'collections');
    tabEnv?.classList.toggle('active', name === 'env');
    tabHist?.classList.toggle('active', name === 'hist');
  };

  tabCollections?.addEventListener('click', () => selectPane('collections'));
  tabEnv?.addEventListener('click', () => selectPane('env'));
  tabHist?.addEventListener('click', () => selectPane('hist'));
  document
    .getElementById('clear-hist')
    ?.addEventListener('click', () => {
      void confirmDialog({
        title: 'Clear activity',
        message: 'Clear all activity?',
        detail: 'This cannot be undone.',
        confirmLabel: 'Clear',
        danger: true,
      }).then((ok) => {
        if (ok) {
          vscode.postMessage({ type: 'clearHistory' });
        }
      });
    });
  newEnvBtn?.addEventListener('click', () =>
    vscode.postMessage({ type: 'newEnv' })
  );
  document
    .getElementById('import')
    ?.addEventListener('click', () => vscode.postMessage({ type: 'import' }));
  document
    .getElementById('import-curl')
    ?.addEventListener('click', () =>
      vscode.postMessage({ type: 'importCurl' })
    );
  document
    .getElementById('new-activity-request')
    ?.addEventListener('click', () =>
      vscode.postMessage({ type: 'newRequest' })
    );
  document
    .getElementById('link-dotenv')
    ?.addEventListener('click', () =>
      vscode.postMessage({ type: 'linkDotenv' })
    );

  selectPane('collections');

  search.addEventListener('input', () => tree.setFilter(search.value));

  newRequestBtn?.addEventListener('click', () =>
    vscode.postMessage({ type: 'newRequest' })
  );
  newCollectionBtn?.addEventListener('click', () =>
    vscode.postMessage({ type: 'newCollection' })
  );

  window.addEventListener('message', (event: MessageEvent<HostToSidebar>) => {
    const message = event.data;
    if (message.type === 'tree') {
      tree.setData(message.collections, message.expanded, message.envNames);
    } else if (message.type === 'activeRequest') {
      tree.setActive(message.requestId);
    } else if (message.type === 'deleteInfo') {
      void promptDelete(message);
    } else if (message.type === 'envs') {
      envList.setData(
        message.environments,
        message.activeEnvId,
        message.collectionEnvModes
      );
    } else if (message.type === 'envDeleteInfo') {
      void promptEnvDelete(message);
    } else if (message.type === 'history') {
      histList?.setData(message.entries);
    }
  });

  vscode.postMessage({ type: 'ready' });
}

export type { NodeKind };
