import { el } from '../dom';
import {
  highlightVars,
  describeVariableAt,
  variableNameAt,
} from './highlight';

/**
 * A single-line input that renders {{variables}} in a highlight colour by
 * layering a transparent input over a mirrored, highlighted span.
 */
/**
 * Maps a client X coordinate to a character offset inside a single-line input
 * by measuring successive prefixes against a hidden canvas context.
 */
let measureContext: CanvasRenderingContext2D | null = null;

function offsetFromPoint(
  input: HTMLInputElement,
  clientX: number
): number | null {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) {
    return null;
  }

  const style = getComputedStyle(input);
  measureContext.font = `${style.fontSize} ${style.fontFamily}`;

  const rect = input.getBoundingClientRect();
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const target = clientX - rect.left - paddingLeft + input.scrollLeft;

  if (target < 0) {
    return null;
  }

  const value = input.value;
  for (let i = 0; i <= value.length; i++) {
    if (measureContext.measureText(value.slice(0, i)).width >= target) {
      return i;
    }
  }

  return value.length;
}

export function modifierLabel(): string {
  return navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';
}

export class VarInput {
  readonly element: HTMLDivElement;
  readonly input: HTMLInputElement;

  private readonly mirror: HTMLElement;

  static onRevealVariable: ((name: string) => void) | null = null;

  constructor(
    placeholder: string,
    className: string,
    private readonly onInput: () => void
  ) {
    this.mirror = el('div', {
      class: 'var-mirror',
      'aria-hidden': 'true',
    });

    this.input = el('input', {
      type: 'text',
      class: `var-input-field ${className}`.trim(),
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      'data-gramm': 'false',
      autocomplete: 'off',
      placeholder,
    }) as HTMLInputElement;
    this.input.spellcheck = false;

    this.element = el('div', { class: 'var-input' }, [
      this.mirror,
      this.input,
    ]) as HTMLDivElement;

    this.input.addEventListener('input', () => {
      this.repaint();
      this.onInput();
    });
    this.input.addEventListener('scroll', () => this.syncScroll());

    this.input.addEventListener('mousemove', (event) =>
      this.updateTooltip(event)
    );
    this.input.addEventListener('mouseleave', () => {
      this.input.title = '';
    });

    this.input.addEventListener('mousedown', (event) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      const offset = offsetFromPoint(this.input, event.clientX);
      const name =
        offset === null ? null : variableNameAt(this.input.value, offset);
      if (name && VarInput.onRevealVariable) {
        event.preventDefault();
        VarInput.onRevealVariable(name);
      }
    });

    this.input.addEventListener('blur', () => {
      const end = this.input.selectionEnd ?? 0;
      this.input.setSelectionRange(end, end);
    });
  }

  private updateTooltip(event: MouseEvent): void {
    const offset = offsetFromPoint(this.input, event.clientX);
    const name =
      offset === null ? null : variableNameAt(this.input.value, offset);
    const description =
      offset === null ? null : describeVariableAt(this.input.value, offset);

    const next = description
      ? `${description}\n\n${modifierLabel()}+click to open`
      : '';
    if (this.input.title !== next) {
      this.input.title = next;
    }

    this.element.classList.toggle(
      'var-target',
      Boolean(name) && (event.metaKey || event.ctrlKey)
    );
  }

  getValue(): string {
    return this.input.value;
  }

  setValue(value: string): void {
    this.input.value = value;
    this.repaint();
  }

  focus(): void {
    this.input.focus();
  }

  repaint(): void {
    this.mirror.innerHTML = highlightVars(this.input.value);
    this.syncScroll();
  }

  private syncScroll(): void {
    this.mirror.scrollLeft = this.input.scrollLeft;
  }
}
