import { el } from '../dom';

export interface FindState {
  query: string;
  matchCase: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

export interface Match {
  /** Zero-based line index. */
  line: number;
  /** Character offset within the line. */
  start: number;
  end: number;
}

/**
 * Finds every occurrence across the given lines. Returns an empty list rather
 * than throwing when a regex is still being typed.
 */
export function findMatches(lines: string[], state: FindState): Match[] {
  if (!state.query) {
    return [];
  }

  let pattern: RegExp;
  try {
    const source = state.useRegex
      ? state.query
      : state.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bounded = state.wholeWord ? `\\b(?:${source})\\b` : source;
    pattern = new RegExp(bounded, state.matchCase ? 'g' : 'gi');
  } catch {
    return [];
  }

  const matches: Match[] = [];

  for (let line = 0; line < lines.length; line++) {
    pattern.lastIndex = 0;
    let found = pattern.exec(lines[line]);

    while (found) {
      // A zero-width match would loop forever; step past it.
      if (found[0].length === 0) {
        pattern.lastIndex++;
      } else {
        matches.push({
          line,
          start: found.index,
          end: found.index + found[0].length,
        });
      }
      found = pattern.exec(lines[line]);
    }
  }

  return matches;
}

export class FindBar {
  readonly element: HTMLDivElement;

  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly wordButton: HTMLButtonElement;
  private readonly regexButton: HTMLButtonElement;

  private state: FindState = {
    query: '',
    matchCase: false,
    useRegex: false,
    wholeWord: false,
  };

  constructor(
    private readonly onChange: (state: FindState) => void,
    private readonly onNavigate: (delta: number) => void,
    private readonly onClose: () => void
  ) {
    this.input = el('input', {
      type: 'text',
      class: 'find-input',
      placeholder: 'Find in response',
      spellcheck: 'false',
    }) as HTMLInputElement;

    this.input.addEventListener('input', () => {
      this.state = { ...this.state, query: this.input.value };
      this.onChange(this.state);
    });

    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onNavigate(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.onClose();
      }
    });

    const toggle = (
      label: string,
      title: string,
      key: 'matchCase' | 'wholeWord' | 'useRegex'
    ): HTMLButtonElement => {
      const button = el('button', {
        class: 'find-toggle',
        type: 'button',
        title,
        'aria-pressed': 'false',
      }, [label]) as HTMLButtonElement;

      button.addEventListener('click', () => {
        this.state = { ...this.state, [key]: !this.state[key] };
        button.classList.toggle('active', this.state[key]);
        button.setAttribute('aria-pressed', String(this.state[key]));
        this.onChange(this.state);
        this.input.focus();
      });

      return button;
    };

    this.caseButton = toggle('Aa', 'Match case', 'matchCase');
    this.wordButton = toggle('ab', 'Match whole word', 'wholeWord');
    this.regexButton = toggle('.*', 'Use regular expression', 'useRegex');

    this.count = el('span', { class: 'find-count' }, ['No results']);

    const prev = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Previous match (Shift+Enter)',
      'aria-label': 'Previous match',
    }, ['↑']) as HTMLButtonElement;
    prev.addEventListener('click', () => this.onNavigate(-1));

    const next = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Next match (Enter)',
      'aria-label': 'Next match',
    }, ['↓']) as HTMLButtonElement;
    next.addEventListener('click', () => this.onNavigate(1));

    const close = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Close (Escape)',
      'aria-label': 'Close find',
    }, ['×']) as HTMLButtonElement;
    close.addEventListener('click', () => this.onClose());

    this.element = el('div', { class: 'find-bar hidden' }, [
      this.input,
      this.caseButton,
      this.wordButton,
      this.regexButton,
      this.count,
      prev,
      next,
      close,
    ]) as HTMLDivElement;
  }

  open(): void {
    this.element.classList.remove('hidden');
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.element.classList.add('hidden');
    this.state = { ...this.state, query: '' };
    this.input.value = '';
    this.onChange(this.state);
  }

  get isOpen(): boolean {
    return !this.element.classList.contains('hidden');
  }

  setStatus(current: number, total: number, invalid: boolean): void {
    this.regexButton.classList.toggle('invalid', invalid);
    this.count.textContent = invalid
      ? 'Invalid pattern'
      : total === 0
      ? this.state.query
        ? 'No results'
        : ''
      : `${current + 1} of ${total}`;
  }
}
