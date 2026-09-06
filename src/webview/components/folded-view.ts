import { el, clear } from '../dom';
import { highlight, type Language } from './highlight';
import { findFoldRegions, isFoldable, type FoldRegion } from './folding';
import { findMatches, type FindState, type Match } from './find-bar';

/**
 * A read-only code view with a folding gutter, used for response bodies.
 * Lines are rendered individually so collapsed regions can be hidden without
 * touching the underlying text.
 */
function isValidPattern(state: FindState): boolean {
  try {
    new RegExp(state.query);
    return true;
  } catch {
    return false;
  }
}

export class FoldedView {
  readonly element: HTMLDivElement;

  private lines: string[] = [];
  private regions: FoldRegion[] = [];
  private readonly collapsed = new Set<number>();
  private language: Language = 'text';
  private matches: Match[] = [];
  private activeMatch = 0;

  constructor() {
    this.element = el('div', { class: 'folded-view' }) as HTMLDivElement;
  }

  setContent(source: string, language: Language): void {
    this.lines = source.split('\n');
    this.language = language;
    this.regions = isFoldable(language) ? findFoldRegions(source, language) : [];
    this.collapsed.clear();
    this.render();
  }

  /** Collapses every top-level region, for very large payloads. */
  collapseAll(): void {
    for (const region of this.regions) {
      this.collapsed.add(region.start);
    }
    this.render();
  }

  expandAll(): void {
    this.collapsed.clear();
    this.render();
  }

  get foldable(): boolean {
    return this.regions.length > 0;
  }

  /** Recomputes matches, expanding any fold that hides one. */
  search(state: FindState): { total: number; invalid: boolean } {
    const invalid = state.useRegex && !isValidPattern(state);
    this.matches = invalid ? [] : findMatches(this.lines, state);
    this.activeMatch = 0;

    for (const match of this.matches) {
      for (const region of this.regions) {
        if (match.line > region.start && match.line <= region.end) {
          this.collapsed.delete(region.start);
        }
      }
    }

    this.render();
    this.revealActive();
    return { total: this.matches.length, invalid };
  }

  step(delta: number): number {
    if (this.matches.length === 0) {
      return 0;
    }
    this.activeMatch =
      (this.activeMatch + delta + this.matches.length) % this.matches.length;
    this.render();
    this.revealActive();
    return this.activeMatch;
  }

  get currentMatch(): number {
    return this.activeMatch;
  }

  get matchCount(): number {
    return this.matches.length;
  }

  private revealActive(): void {
    const active = this.element.querySelector('.find-match.active');
    active?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  /** Wraps matches on a line in highlight spans, over already-highlighted HTML. */
  private applyMatches(html: string, lineIndex: number): string {
    const onLine = this.matches.filter((m) => m.line === lineIndex);
    if (onLine.length === 0) {
      return html;
    }

    // Walk the rendered HTML, counting only visible text so offsets from the
    // plain source line up with positions inside the markup.
    let plainIndex = 0;
    let out = '';
    let i = 0;

    const activeGlobal = this.matches[this.activeMatch];

    while (i < html.length) {
      if (html[i] === '<') {
        const close = html.indexOf('>', i);
        const stop = close === -1 ? html.length : close + 1;
        out += html.slice(i, stop);
        i = stop;
        continue;
      }

      // Entities count as a single visible character.
      let piece = html[i];
      let step = 1;
      if (piece === '&') {
        const semi = html.indexOf(';', i);
        if (semi !== -1 && semi - i <= 6) {
          piece = html.slice(i, semi + 1);
          step = piece.length;
        }
      }

      const starting = onLine.find((m) => m.start === plainIndex);
      if (starting) {
        const isActive =
          activeGlobal &&
          activeGlobal.line === starting.line &&
          activeGlobal.start === starting.start;
        out += `<span class="find-match${isActive ? ' active' : ''}">`;
      }

      out += piece;
      plainIndex += 1;
      i += step;

      if (onLine.some((m) => m.end === plainIndex)) {
        out += '</span>';
      }
    }

    return out;
  }

  private hiddenLines(): Set<number> {
    const hidden = new Set<number>();
    for (const region of this.regions) {
      if (!this.collapsed.has(region.start)) {
        continue;
      }
      for (let i = region.start + 1; i <= region.end; i++) {
        hidden.add(i);
      }
    }
    return hidden;
  }

  private render(): void {
    clear(this.element);

    const hidden = this.hiddenLines();
    const starts = new Map(this.regions.map((r) => [r.start, r]));

    for (let i = 0; i < this.lines.length; i++) {
      const region = starts.get(i);
      const isCollapsed = region ? this.collapsed.has(i) : false;

      const gutter = el('span', { class: 'fold-gutter' });
      if (region) {
        gutter.classList.add('foldable');
        gutter.classList.toggle('collapsed', isCollapsed);
        gutter.title = isCollapsed ? 'Expand' : 'Collapse';
        gutter.setAttribute('role', 'button');
        gutter.tabIndex = 0;

        const toggle = (): void => {
          if (this.collapsed.has(i)) {
            this.collapsed.delete(i);
          } else {
            this.collapsed.add(i);
          }
          this.render();
        };

        gutter.addEventListener('click', toggle);
        gutter.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        });
      }

      const code = el('span', { class: 'fold-code' });
      code.innerHTML = this.applyMatches(
        highlight(this.lines[i], this.language),
        i
      );

      const children: (Node | string)[] = [gutter, code];

      if (isCollapsed && region) {
        const count = region.end - region.start;
        children.push(
          el('span', {
            class: 'fold-summary',
            title: `${count} hidden line${count === 1 ? '' : 's'}`,
            'aria-hidden': 'true',
          }, [`⋯ ${count} lines`])
        );
      }

      const row = el(
        'div',
        {
          class: `fold-line ${hidden.has(i) ? 'fold-hidden' : ''}`.trim(),
        },
        children
      );

      this.element.append(row);
    }
  }
}
