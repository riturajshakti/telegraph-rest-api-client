import { el, clear } from '../dom';
import { locate, type BodyIssue } from '../../core/validate';

const XHTML = 'http://www.w3.org/1999/xhtml';

function offsetFor(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) {
      return text.length;
    }
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(offset + Math.max(0, column - 1), limit);
}

export function validateXml(text: string): BodyIssue | null {
  if (!text.trim()) {
    return null;
  }

  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagNameNS(XHTML, 'parsererror')[0];
  if (!error) {
    return null;
  }

  const detail = error.textContent ?? '';
  const match = /line (\d+) at column (\d+):\s*(.+)/.exec(detail);
  if (!match) {
    return {
      message: detail.trim() || 'The XML is not well-formed',
      offset: 0,
      line: 1,
      column: 1,
    };
  }

  const offset = offsetFor(text, Number(match[1]), Number(match[2]));
  const message = match[3].trim();
  return {
    message: message.charAt(0).toUpperCase() + message.slice(1),
    offset,
    ...locate(text, offset),
  };
}

export class IssueBanner {
  readonly element: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly where: HTMLButtonElement;
  private offset = 0;

  constructor(onReveal: (offset: number) => void) {
    this.text = el('span', { class: 'body-issue-text' });
    this.where = el('button', {
      class: 'body-issue-where',
      type: 'button',
      title: 'Show this position in the editor',
    }) as HTMLButtonElement;
    this.where.addEventListener('click', () => onReveal(this.offset));

    this.element = el('div', { class: 'body-issue hidden', role: 'status' }, [
      el('span', { class: 'body-issue-icon', 'aria-hidden': 'true' }, ['!']),
      this.text,
      this.where,
    ]) as HTMLDivElement;
  }

  get visible(): boolean {
    return !this.element.classList.contains('hidden');
  }

  show(issue: BodyIssue | null, label: string): void {
    this.element.classList.toggle('hidden', !issue);
    if (!issue) {
      return;
    }
    this.offset = issue.offset;
    clear(this.text);
    this.text.append(el('strong', {}, [`Invalid ${label}`]), ` — ${issue.message}`);
    this.where.textContent = `Line ${issue.line}, column ${issue.column}`;
  }
}
