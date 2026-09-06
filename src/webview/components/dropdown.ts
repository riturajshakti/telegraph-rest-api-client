import { el, clear } from '../dom';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  className?: string;
}

interface Closable {
  element: HTMLElement;
  close(): void;
}

const openDropdowns = new Set<Closable>();

document.addEventListener('click', (event) => {
  for (const dropdown of [...openDropdowns]) {
    if (!dropdown.element.contains(event.target as Node)) {
      dropdown.close();
    }
  }
});

export class Dropdown<T extends string> {
  readonly element: HTMLDivElement;

  private readonly trigger: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly menu: HTMLDivElement;

  private options: DropdownOption<T>[] = [];
  private current!: T;
  private highlighted = 0;
  private isOpen = false;

  constructor(
    options: DropdownOption<T>[],
    initial: T,
    private readonly onChange: (value: T) => void,
    private readonly className = ''
  ) {
    this.label = el('span', { class: 'dd-label' });
    this.trigger = el(
      'button',
      {
        type: 'button',
        class: 'dd-trigger',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
      [this.label, el('span', { class: 'dd-caret' })]
    ) as HTMLButtonElement;

    this.menu = el('div', {
      class: 'dd-menu',
      role: 'listbox',
    }) as HTMLDivElement;

    this.element = el('div', { class: `dd ${this.className}`.trim() }, [
      this.trigger,
      this.menu,
    ]) as HTMLDivElement;

    this.trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle();
    });

    this.trigger.addEventListener('keydown', (event) =>
      this.onTriggerKeydown(event)
    );

    this.setOptions(options, initial);
  }

  setOptions(options: DropdownOption<T>[], value: T): void {
    this.options = options;
    this.current = value;
    this.renderMenu();
    this.syncLabel();
  }

  getValue(): T {
    return this.current;
  }

  setValue(value: T, notify = false): void {
    if (!this.options.some((o) => o.value === value)) {
      return;
    }
    this.current = value;
    this.syncLabel();
    this.renderMenu();
    if (notify) {
      this.onChange(value);
    }
  }

  private syncLabel(): void {
    const option = this.options.find((o) => o.value === this.current);
    this.label.textContent = option?.label ?? '';
    this.element.dataset.value = this.current;
    this.trigger.className = `dd-trigger ${option?.className ?? ''}`.trim();
  }

  private renderMenu(): void {
    clear(this.menu);

    this.options.forEach((option, index) => {
      const selected = option.value === this.current;
      const item = el(
        'div',
        {
          class: `dd-item ${option.className ?? ''}`.trim(),
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
        },
        [
          el('span', { class: 'dd-check' }, [selected ? '✓' : '']),
          el('span', { class: 'dd-item-label' }, [option.label]),
        ]
      );

      if (selected) {
        item.classList.add('selected');
      }
      if (index === this.highlighted) {
        item.classList.add('highlighted');
      }

      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.select(index);
      });

      item.addEventListener('mouseenter', () => {
        this.highlighted = index;
        this.syncHighlight();
      });

      this.menu.append(item);
    });
  }

  private syncHighlight(): void {
    const items = this.menu.querySelectorAll('.dd-item');
    items.forEach((item, index) => {
      item.classList.toggle('highlighted', index === this.highlighted);
    });
  }

  private select(index: number): void {
    const option = this.options[index];
    if (!option) {
      return;
    }
    const changed = option.value !== this.current;
    this.current = option.value;
    this.close();
    this.syncLabel();
    this.renderMenu();
    if (changed) {
      this.onChange(option.value);
    }
  }

  private toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    for (const other of [...openDropdowns]) {
      other.close();
    }

    this.highlighted = Math.max(
      0,
      this.options.findIndex((o) => o.value === this.current)
    );
    this.renderMenu();

    this.isOpen = true;
    this.element.classList.add('open');
    this.trigger.setAttribute('aria-expanded', 'true');
    openDropdowns.add(this);

    this.positionMenu();
    this.trigger.focus();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.element.classList.remove('open', 'drop-up');
    this.trigger.setAttribute('aria-expanded', 'false');
    openDropdowns.delete(this);
  }

  private positionMenu(): void {
    const rect = this.trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const needed = Math.min(this.options.length * 26 + 10, 260);
    this.element.classList.toggle(
      'drop-up',
      spaceBelow < needed && rect.top > spaceBelow
    );
  }

  private onTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.isOpen) {
          this.open();
        } else {
          this.highlighted = Math.min(
            this.highlighted + 1,
            this.options.length - 1
          );
          this.syncHighlight();
        }
        break;

      case 'ArrowUp':
        event.preventDefault();
        if (this.isOpen) {
          this.highlighted = Math.max(this.highlighted - 1, 0);
          this.syncHighlight();
        }
        break;

      case 'Enter':
      case ' ':
        event.preventDefault();
        if (this.isOpen) {
          this.select(this.highlighted);
        } else {
          this.open();
        }
        break;

      case 'Escape':
        if (this.isOpen) {
          event.preventDefault();
          this.close();
        }
        break;

      case 'Tab':
        this.close();
        break;
    }
  }
}
