import { el, clear } from './dom';
import { KeyValueTable } from './components/kv-table';
import type { Environment, CollectionSettings, EnvMode } from '../core/types';
import { Segmented } from './components/segmented';

declare function acquireVsCodeApi(): {
  postMessage(message: EnvToHost): void;
};

export type EnvToHost =
  | { type: 'ready' }
  | { type: 'saveEnv'; environment: Environment }
  | { type: 'saveSettings'; colId: string; settings: CollectionSettings }
  | { type: 'linkDotenv' }
  | { type: 'convertEnv'; colId: string; to: 'embedded' | 'linked' };

export type HostToEnv =
  | { type: 'saveRequested' }
  | { type: 'initEnv'; environment: Environment; focusKey?: string }
  | {
      type: 'initCollection';
      colId: string;
      colName: string;
      settings: CollectionSettings;
      available: { id: string; name: string; dotenv?: boolean }[];
    }
  | { type: 'saved' };

const vscode = acquireVsCodeApi();

function dotfileWarningTitle(): string {
  return navigator.platform.toLowerCase().includes('win')
    ? 'Cannot see your .env file? '
    : 'Files starting with a dot are hidden by default. ';
}

function dotfileHint(): string {
  const platform = navigator.platform.toLowerCase();

  if (platform.includes('mac')) {
    return 'Press Cmd+Shift+. in the file dialog to show them, or paste the full path into the dialog with Cmd+Shift+G.';
  }

  if (platform.includes('win')) {
    // Windows hides files by attribute, not by a leading dot, so a .env file
    // is usually visible already.
    return 'On Windows a .env file is normally visible. If it is marked hidden, turn on View \u2192 Show \u2192 Hidden items in Explorer, or type the full path into the dialog.';
  }

  return 'Press Ctrl+H in the file dialog to show them, or type the full path into the dialog.';
}

class EnvView {
  private root!: HTMLElement;
  private table!: KeyValueTable;
  private saveButton!: HTMLButtonElement;
  private dirty = false;

  private environment: Environment | null = null;
  private colId = '';
  private settings: CollectionSettings = { envMode: 'none' };
  private available: { id: string; name: string; dotenv?: boolean }[] = [];
  private modeTabs!: Segmented<EnvMode>;
  private modeBody!: HTMLDivElement;

  mount(root: HTMLElement): void {
    this.root = root;
  }

  private markDirty(): void {
    this.dirty = true;
    this.syncSave();
  }

  private syncSave(): void {
    this.saveButton.textContent = this.dirty ? 'Save •' : 'Saved';
    this.saveButton.disabled = !this.dirty;
  }

  showEnvironment(environment: Environment, focusKey?: string): void {
    this.environment = environment;
    this.colId = '';
    this.dirty = false;
    clear(this.root);

    this.table = new KeyValueTable('Variable', 'Value', () => {
      this.markDirty();
    });
    this.table.setRows(environment.data);

    this.saveButton = el('button', { class: 'btn btn-primary' }, [
      'Saved',
    ]) as HTMLButtonElement;
    this.saveButton.addEventListener('click', () => this.saveEnv());

    const linkBtn = el('button', { class: 'btn btn-ghost' }, [
      environment.dotenvPath
        ? 'Import from a different .env file'
        : 'Import from .env file',
    ]) as HTMLButtonElement;
    linkBtn.addEventListener('click', () =>
      vscode.postMessage({ type: 'linkDotenv' })
    );

    const dotfileInfo = el('button', {
      class: 'icon-btn dotfile-info',
      type: 'button',
      title: `${dotfileWarningTitle()}${dotfileHint()}`,
      'aria-label': 'Why can I not see my .env file?',
    }, ['\u24d8']) as HTMLButtonElement;

    const dotfilePopup = el('div', { class: 'dotfile-popup hidden' }, [
      el('strong', {}, [dotfileWarningTitle()]),
      dotfileHint(),
    ]);

    dotfileInfo.addEventListener('click', (event) => {
      event.stopPropagation();
      dotfilePopup.classList.toggle('hidden');
    });
    document.addEventListener('click', () =>
      dotfilePopup.classList.add('hidden')
    );

    this.root.append(
      el('div', { class: 'env-page' }, [
        el('div', { class: 'env-header' }, [
          el('h2', { class: 'env-title' }, [environment.name]),
          el('div', { class: 'env-header-center' }, [
            linkBtn,
            el('span', { class: 'dotfile-wrap' }, [dotfileInfo, dotfilePopup]),
          ]),
          this.saveButton,
        ]),
        el('p', { class: 'env-hint' }, [
          environment.dotenvPath
            ? `Linked to ${environment.dotenvPath} — use the sidebar menu to reload from disk. Reference with {{name}}.`
            : 'Reference these anywhere in a request with {{name}} — URL, headers, query, body, or auth.',
        ]),
        this.table.element,
      ])
    );

    this.syncSave();

    if (focusKey) {
      requestAnimationFrame(() => this.focusVariable(focusKey));
    }
  }

  private focusVariable(name: string): void {
    const inputs = Array.from(
      this.table.element.querySelectorAll('.kv-name')
    ) as HTMLInputElement[];

    for (const input of inputs) {
      if (input.value !== name) {
        continue;
      }
      const row = input.closest('.kv-row');
      row?.classList.add('kv-focused');
      setTimeout(() => row?.classList.remove('kv-focused'), 2200);
      const value = row?.querySelector('.kv-value') as HTMLInputElement | null;
      const target = value ?? input;
      target.focus();
      target.select();
      input.scrollIntoView({ block: 'center' });
      return;
    }
  }

  /** Routes Cmd/Ctrl+S to whichever editor this panel is showing. */
  requestSave(): void {
    if (this.environment) {
      this.saveEnv();
    } else if (this.colId) {
      this.saveSettings();
    }
  }

  private saveEnv(): void {
    if (!this.environment || !this.dirty) {
      return;
    }
    this.environment.data = this.table.getRows();
    vscode.postMessage({ type: 'saveEnv', environment: this.environment });
  }

  showCollection(
    colId: string,
    colName: string,
    settings: CollectionSettings,
    available: { id: string; name: string; dotenv?: boolean }[]
  ): void {
    this.colId = colId;
    this.environment = null;
    this.settings = settings;
    this.available = available;
    this.dirty = false;
    clear(this.root);

    this.saveButton = el('button', { class: 'btn btn-primary' }, [
      'Saved',
    ]) as HTMLButtonElement;
    this.saveButton.addEventListener('click', () => this.saveSettings());

    this.modeTabs = new Segmented<EnvMode>(
      [
        { value: 'none', label: 'None' },
        { value: 'embedded', label: 'Embedded' },
        { value: 'linked', label: 'Linked' },
      ],
      settings.envMode,
      (value) => {
        this.settings.envMode = value;
        this.renderModeBody();
        this.markDirty();
      }
    );

    this.modeBody = el('div', { class: 'env-mode-body' }) as HTMLDivElement;

    this.root.append(
      el('div', { class: 'env-page' }, [
        el('div', { class: 'env-header' }, [
          el('h2', { class: 'env-title' }, [`${colName} — Environment`]),
          this.saveButton,
        ]),
        el('div', { class: 'env-mode-row' }, [this.modeTabs.element]),
        this.modeBody,
      ])
    );

    this.renderModeBody();
    this.syncSave();
  }

  private renderModeBody(): void {
    clear(this.modeBody);
    const mode = this.settings.envMode;

    if (mode === 'none') {
      this.modeBody.append(
        el('p', { class: 'env-hint' }, [
          'This collection uses only the globally selected environment.',
        ])
      );
      return;
    }

    if (mode === 'embedded') {
      this.settings.embeddedEnv ??= { name: 'Embedded', data: [] };

      const toLinked = el('button', { class: 'btn btn-ghost btn-tiny' }, [
        'Move to a shared environment',
      ]) as HTMLButtonElement;
      toLinked.addEventListener('click', () =>
        vscode.postMessage({
          type: 'convertEnv',
          colId: this.colId,
          to: 'linked',
        })
      );
      this.modeBody.append(
        el('div', { class: 'env-convert-row' }, [toLinked])
      );
      const table = new KeyValueTable('Variable', 'Value', () => {
        this.settings.embeddedEnv!.data = table.getRows();
        this.markDirty();
      });
      table.setRows(this.settings.embeddedEnv.data);

      this.modeBody.append(
        el('p', { class: 'env-hint' }, [
          'Variables stored inside this collection. They override the selected environment and travel with the collection when exported.',
        ]),
        table.element
      );
      return;
    }

    this.settings.linkedEnvIds ??= [];

    if (this.available.length === 0) {
      this.modeBody.append(
        el('p', { class: 'env-hint' }, [
          'No standalone environments yet. Create one from the Env tab in the sidebar, or link a .env file there.',
        ])
      );
      return;
    }

    const toEmbedded = el('button', { class: 'btn btn-ghost btn-tiny' }, [
      'Copy into this collection',
    ]) as HTMLButtonElement;
    toEmbedded.addEventListener('click', () =>
      vscode.postMessage({
        type: 'convertEnv',
        colId: this.colId,
        to: 'embedded',
      })
    );
    this.modeBody.append(
      el('div', { class: 'env-convert-row' }, [toEmbedded])
    );

    const list = el('div', { class: 'env-link-list' });
    for (const env of this.available) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'kv-check',
      }) as HTMLInputElement;
      checkbox.checked = this.settings.linkedEnvIds.includes(env.id);
      checkbox.addEventListener('change', () => {
        const ids = new Set(this.settings.linkedEnvIds ?? []);
        if (checkbox.checked) {
          ids.add(env.id);
        } else {
          ids.delete(env.id);
        }
        this.settings.linkedEnvIds = [...ids];
        this.markDirty();
      });

      list.append(
        el('label', { class: 'env-link-row' }, [
          el('span', { class: 'kv-check-hit' }, [checkbox]),
          el('span', {}, [env.name]),
          env.dotenv
            ? el('span', { class: 'env-dotenv-chip' }, ['.env'])
            : el('span'),
        ])
      );
    }

    this.modeBody.append(
      el('p', { class: 'env-hint' }, [
        'Share environments across collections. Linked variables override the globally selected environment. Environments backed by a .env file are marked below.',
      ]),
      list
    );
  }

  private saveSettings(): void {
    if (!this.dirty) {
      return;
    }
    vscode.postMessage({
      type: 'saveSettings',
      colId: this.colId,
      settings: this.settings,
    });
  }

  onSaved(): void {
    this.dirty = false;
    this.syncSave();
  }
}

const view = new EnvView();
const root = document.getElementById('app');

if (root) {
  view.mount(root);

  window.addEventListener('message', (event: MessageEvent<HostToEnv>) => {
    const message = event.data;
    if (message.type === 'saveRequested') {
      view.requestSave();
      return;
    }
    if (message.type === 'initEnv') {
      view.showEnvironment(message.environment, message.focusKey);
    } else if (message.type === 'initCollection') {
      view.showCollection(
        message.colId,
        message.colName,
        message.settings,
        message.available
      );
    } else if (message.type === 'saved') {
      view.onSaved();
    }
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      view.requestSave();
    }
  });

  vscode.postMessage({ type: 'ready' });
}
