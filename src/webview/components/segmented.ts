import { el, clear } from '../dom';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export class Segmented<T extends string> {
  readonly element: HTMLDivElement;

  private options: SegmentOption<T>[] = [];
  private current!: T;
  private readonly buttons = new Map<T, HTMLButtonElement>();

  constructor(
    options: SegmentOption<T>[],
    initial: T,
    private readonly onChange: (value: T) => void
  ) {
    this.element = el('div', {
      class: 'segmented',
      role: 'tablist',
    }) as HTMLDivElement;

    this.setOptions(options, initial);
  }

  setOptions(options: SegmentOption<T>[], value: T): void {
    this.options = options;
    this.current = value;
    this.render();
  }

  getValue(): T {
    return this.current;
  }

  setValue(value: T, notify = false): void {
    if (!this.options.some((o) => o.value === value)) {
      return;
    }
    this.current = value;
    this.syncActive();
    if (notify) {
      this.onChange(value);
    }
  }

  private render(): void {
    clear(this.element);
    this.buttons.clear();

    for (const option of this.options) {
      const button = el(
        'button',
        {
          type: 'button',
          class: 'segment',
          role: 'tab',
          'data-value': option.value,
        },
        [option.label]
      ) as HTMLButtonElement;

      button.addEventListener('click', () => this.select(option.value));
      button.addEventListener('keydown', (event) =>
        this.onKeydown(event, option.value)
      );

      this.buttons.set(option.value, button);
      this.element.append(button);
    }

    this.syncActive();
  }

  private syncActive(): void {
    for (const [value, button] of this.buttons) {
      const active = value === this.current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    }
  }

  private select(value: T): void {
    if (value === this.current) {
      return;
    }
    this.current = value;
    this.syncActive();
    this.onChange(value);
  }

  private onKeydown(event: KeyboardEvent, value: T): void {
    const index = this.options.findIndex((o) => o.value === value);
    let next = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (index + 1) % this.options.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + this.options.length) % this.options.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = this.options.length - 1;
    }

    if (next >= 0) {
      event.preventDefault();
      const option = this.options[next];
      this.select(option.value);
      this.buttons.get(option.value)?.focus();
    }
  }
}
