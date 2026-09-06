import { el, clear } from '../dom';
import { VarInput } from './var-input';
import type { KeyValue } from '../../core/types';

let dragIndex: number | null = null;
let dropIndex: number | null = null;

export class KeyValueTable {
  readonly element: HTMLDivElement;
  private rows: KeyValue[] = [];

  static onPickFile: ((apply: (path: string) => void) => void) | null = null;

  constructor(
    private readonly namePlaceholder: string,
    private readonly valuePlaceholder: string,
    private readonly onChange: () => void,
    private readonly allowFiles = false
  ) {
    this.element = el('div', { class: 'kv-table' });
    this.setRows([]);
  }

  setRows(rows: KeyValue[]): void {
    this.rows = rows.map((r) => ({ ...r }));
    this.render();
  }

  repaint(): void {
    this.render();
  }

  getRows(): KeyValue[] {
    return this.rows
      .filter((r) => r.name.trim() !== '' || r.value.trim() !== '')
      .map((r) => ({ ...r }));
  }

  private appendBlankRow(): void {
    this.element.append(this.buildRow({ name: '', value: '' }, -1, true));
  }

  private render(): void {
    clear(this.element);

    this.rows.forEach((row, index) => {
      this.element.append(this.buildRow(row, index, false));
    });
    this.appendBlankRow();
  }

  private buildRow(row: KeyValue, index: number, isBlank: boolean): HTMLElement {
    const checkbox = el('input', {
      type: 'checkbox',
      class: 'kv-check',
    }) as HTMLInputElement;
    checkbox.checked = isBlank ? false : !row.isDisabled;
    checkbox.disabled = isBlank;
    checkbox.addEventListener('change', () => {
      if (!isBlank) {
        this.rows[index].isDisabled = !checkbox.checked;
        this.onChange();
      }
    });

    let owned: KeyValue | null = isBlank ? null : this.rows[index];

    const nameField = new VarInput(
      this.namePlaceholder,
      'kv-input kv-name',
      () => commit()
    );
    nameField.setValue(row.name);
    const name = nameField.input;

    const valueField = new VarInput(
      this.valuePlaceholder,
      'kv-input kv-value',
      () => commit()
    );
    valueField.setValue(row.value);
    const value = valueField.input;

    const commit = (): void => {
      if (!owned) {
        if (name.value === '' && value.value === '') {
          return;
        }
        owned = { name: '', value: '', isDisabled: false };
        this.rows.push(owned);
        row_el.classList.remove('kv-row-blank');
        checkbox.disabled = false;
        checkbox.checked = true;
        spacer.replaceWith(remove);
        this.appendBlankRow();
        if (this.rows.length === 2) {
          // Re-render enables dragging now that a second row exists, but it
          // rebuilds every row — restore focus and caret so typing continues.
          const active = document.activeElement as HTMLInputElement | null;
          const isName = active === name;
          const caret = active?.selectionStart ?? null;
          const rowIndex = this.rows.length - 1;

          queueMicrotask(() => {
            this.render();
            const rows = this.element.querySelectorAll('.kv-row');
            const target = rows[rowIndex]?.querySelector<HTMLInputElement>(
              isName ? '.kv-name' : '.kv-value'
            );
            if (target) {
              target.focus();
              if (caret !== null) {
                target.setSelectionRange(caret, caret);
              }
            }
          });
        }
      }
      owned.name = name.value;
      owned.value = value.value;
      this.onChange();
    };

    const fileBtn = this.allowFiles
      ? (el('button', {
          class: 'icon-btn kv-file',
          type: 'button',
          title: row.isFile ? 'Choose a different file' : 'Attach a file',
          'aria-label': 'Attach a file',
        }, [row.isFile ? '📎' : '＋']) as HTMLButtonElement)
      : null;

    if (fileBtn) {
      fileBtn.addEventListener('click', () => {
        KeyValueTable.onPickFile?.((path) => {
          if (!owned) {
            owned = { name: name.value || 'file', value: '', isDisabled: false };
            this.rows.push(owned);
            row_el.classList.remove('kv-row-blank');
            this.appendBlankRow();
          }
          owned.value = path;
          owned.isFile = true;
          valueField.setValue(path);
          value.value = path;
          this.onChange();
          this.render();
        });
      });
    }

    const spacer = el('span', { class: 'kv-remove-spacer' });

    const remove = el('button', {
      class: 'kv-remove',
      title: 'Remove',
      type: 'button',
    }, ['×']);
    remove.addEventListener('click', () => {
      const at = owned ? this.rows.indexOf(owned) : -1;
      if (at >= 0) {
        this.rows.splice(at, 1);
      }
      this.render();
      this.onChange();
    });

    const checkWrap = el('label', { class: 'kv-check-hit' }, [checkbox]);

    const row_el = el('div', {
      class: `kv-row ${isBlank ? 'kv-row-blank' : ''}`.trim(),
    }, [
      checkWrap,
      nameField.element,
      valueField.element,
      ...(fileBtn ? [fileBtn] : []),
      isBlank ? spacer : remove,
    ]);

    if (!isBlank && this.rows.length > 1) {
      this.makeReorderable(row_el, checkWrap, index);
    }

    return row_el;
  }

  private makeReorderable(
    row: HTMLElement,
    handle: HTMLElement,
    index: number
  ): void {
    row.draggable = true;

    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', 'Hold to reorder, or use arrow keys');
    handle.title = 'Hold to drag, or focus and use ↑/↓';

    handle.addEventListener('keydown', (event: KeyboardEvent) => {
      const delta =
        event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const to = index + delta;
      if (to < 0 || to >= this.rows.length) {
        return;
      }
      this.reorder(index, to);
      const handles =
        this.element.querySelectorAll<HTMLElement>('.kv-check-hit');
      handles[to]?.focus();
    });

    row.addEventListener('dragstart', (event) => {
      const from = event.target as HTMLElement | null;
      if (from && (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA')) {
        event.preventDefault();
        return;
      }
      dragIndex = index;
      row.classList.add('kv-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      }
    });

    row.addEventListener('dragend', () => {
      dragIndex = null;
      row.classList.remove('kv-dragging');
      this.clearMarkers();
    });

    row.addEventListener('dragover', (event) => {
      if (dragIndex === null || dragIndex === index) {
        return;
      }
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      this.clearMarkers();
      row.classList.add(after ? 'kv-drop-after' : 'kv-drop-before');
      dropIndex = after ? index + 1 : index;
    });

    row.addEventListener('drop', (event) => {
      if (dragIndex === null || dropIndex === null) {
        return;
      }
      event.preventDefault();
      const from = dragIndex;
      const to = dropIndex > from ? dropIndex - 1 : dropIndex;
      dragIndex = null;
      dropIndex = null;
      this.clearMarkers();
      this.reorder(from, to);
    });
  }

  private clearMarkers(): void {
    this.element
      .querySelectorAll('.kv-drop-before, .kv-drop-after')
      .forEach((node) => {
        node.classList.remove('kv-drop-before', 'kv-drop-after');
      });
  }

  private reorder(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.rows.length) {
      return;
    }
    const [moved] = this.rows.splice(from, 1);
    this.rows.splice(to, 0, moved);
    this.render();
    this.onChange();
  }
}
