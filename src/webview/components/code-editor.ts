import { el } from '../dom';
import {
  highlight,
  describeVariableAt,
  variableNameAt,
  type Language,
} from './highlight';
import { findFoldRegions, isFoldable, type FoldRegion } from './folding';
import { modifierLabel } from './var-input';
import { jsObjectToJson } from '../../core/js-object';

const INDENT = '  ';

export class CodeEditor {
  readonly element: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;

  private readonly pre: HTMLPreElement;
  private readonly code: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly scrollTrack: HTMLElement;
  private readonly scrollThumb: HTMLElement;
  private language: Language = 'text';
  private regions: FoldRegion[] = [];
  private readonly collapsed = new Set<number>();
  private pendingResize = false;

  static onRevealVariable: ((name: string) => void) | null = null;

  constructor(
    placeholder: string,
    private readonly onInput: () => void
  ) {
    this.code = el('code', { class: 'code-highlight' });
    this.pre = el('pre', { class: 'code-layer', 'aria-hidden': 'true' }, [
      this.code,
    ]) as HTMLPreElement;

    this.textarea = el('textarea', {
      class: 'code-input',
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      'data-gramm': 'false',
      autocomplete: 'off',
      placeholder,
    }) as HTMLTextAreaElement;
    this.textarea.spellcheck = false;

    this.gutter = el('div', { class: 'code-gutter', 'aria-hidden': 'true' });

    // The textarea is `opacity: 0`, so it paints no scrollbar of its own, and
    // the highlight layer cannot be raised above it without swallowing caret
    // clicks. A separate bar sits outside the text flow instead: it takes the
    // mouse without ever covering the text.
    this.scrollThumb = el('div', { class: 'code-scroll-thumb' });
    this.scrollTrack = el('div', {
      class: 'code-scroll-track',
      'aria-hidden': 'true',
    }, [this.scrollThumb]);

    this.element = el('div', { class: 'code-editor' }, [
      this.gutter,
      this.pre,
      this.textarea,
      this.scrollTrack,
    ]) as HTMLDivElement;

    this.wireScrollbar();

    this.textarea.addEventListener('input', () => {
      this.repaint();
      this.onInput();
    });

    this.textarea.addEventListener('scroll', () => this.syncScroll());

    // Wrapping depends on width, so arrow positions must be re-measured.
    new ResizeObserver(() => {
      if (this.pendingResize) {
        this.autoSize();
      }
      this.positionArrows();
    }).observe(this.textarea);

    // A tab switch reveals the editor; only then can it be measured.
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && this.pendingResize) {
        this.autoSize();
        this.positionArrows();
      }
    }).observe(this.element);
    this.textarea.addEventListener('select', () =>
      this.repaintSelectionOnly()
    );
    this.textarea.addEventListener('keyup', () => this.paintOnSelectionChange());
    this.textarea.addEventListener('mouseup', () =>
      this.paintOnSelectionChange()
    );
    this.textarea.addEventListener('mousemove', (event: MouseEvent) => {
      if (event.buttons === 1) {
        this.scheduleSelectionPaint();
      }
    });
    this.textarea.addEventListener('focus', () =>
      this.repaintSelectionOnly()
    );
    this.textarea.addEventListener('blur', () => this.repaintSelectionOnly());
    this.textarea.addEventListener('click', () =>
      this.paintOnSelectionChange()
    );
    this.textarea.addEventListener('keydown', (event) =>
      this.onKeydown(event)
    );

    this.textarea.addEventListener('paste', (event) =>
      this.onPaste(event)
    );

    this.textarea.addEventListener('mousemove', (event) =>
      this.updateTooltip(event)
    );
    this.textarea.addEventListener('mouseleave', () => {
      this.textarea.title = '';
    });

    this.textarea.addEventListener('mousedown', (event) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      const offset = this.offsetFromPoint(event.clientX, event.clientY);
      const name =
        offset === null ? null : variableNameAt(this.textarea.value, offset);
      if (name && CodeEditor.onRevealVariable) {
        event.preventDefault();
        CodeEditor.onRevealVariable(name);
      }
    });

  }

  /**
   * The highlight layer sits under the textarea and never sees the mouse, so
   * the tooltip is placed on the textarea using the character offset found by
   * hit-testing the mirrored text.
   */
  private updateTooltip(event: MouseEvent): void {
    const offset = this.offsetFromPoint(event.clientX, event.clientY);
    const description =
      offset === null
        ? null
        : describeVariableAt(this.textarea.value, offset);
    const next = description
      ? `${description}\n\n${modifierLabel()}+click to open`
      : '';
    if (this.textarea.title !== next) {
      this.textarea.title = next;
    }

    this.element.classList.toggle(
      'var-target',
      Boolean(description) && (event.metaKey || event.ctrlKey)
    );
  }

  private offsetFromPoint(x: number, y: number): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };

    const previous = this.pre.style.pointerEvents;
    this.pre.style.pointerEvents = 'auto';
    const taEvents = this.textarea.style.pointerEvents;
    this.textarea.style.pointerEvents = 'none';

    let node: Node | null = null;
    let nodeOffset = 0;

    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y);
      if (position) {
        node = position.offsetNode;
        nodeOffset = position.offset;
      }
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        nodeOffset = range.startOffset;
      }
    }

    this.pre.style.pointerEvents = previous;
    this.textarea.style.pointerEvents = taEvents;

    if (!node || !this.code.contains(node)) {
      return null;
    }

    const walker = document.createTreeWalker(
      this.code,
      NodeFilter.SHOW_TEXT
    );
    let total = 0;
    let current = walker.nextNode();

    while (current) {
      if (current === node) {
        return total + nodeOffset;
      }
      total += current.textContent?.length ?? 0;
      current = walker.nextNode();
    }

    return null;
  }

  private onPaste(event: ClipboardEvent): void {
    if (this.language !== 'json') {
      return;
    }

    const pasted = event.clipboardData?.getData('text/plain');
    if (!pasted) {
      return;
    }

    const area = this.textarea;
    const replacingAll =
      area.selectionStart === 0 && area.selectionEnd === area.value.length;
    if (!replacingAll && area.value.trim() !== '') {
      return;
    }

    const converted = jsObjectToJson(pasted);
    if (!converted) {
      return;
    }

    event.preventDefault();
    this.setValue(converted);
    area.setSelectionRange(converted.length, converted.length);
    this.onInput();
    this.flashHint('Converted JS object to JSON');
  }

  private flashHint(text: string): void {
    const hint = el('div', { class: 'editor-hint' }, [text]);
    this.element.append(hint);
    setTimeout(() => hint.classList.add('fade'), 1400);
    setTimeout(() => hint.remove(), 2000);
  }

  private lineRange(): { start: number; end: number } {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
    let end = value.indexOf('\n', selectionEnd);
    if (end === -1) {
      end = value.length;
    }
    return { start, end };
  }

  private toggleComment(): void {
    const token =
      this.language === 'graphql'
        ? '# '
        : this.language === 'xml'
        ? null
        : '// ';
    if (!token) {
      return;
    }

    const area = this.textarea;
    const { start, end } = this.lineRange();
    const block = area.value.slice(start, end);
    const lines = block.split('\n');
    const marker = token.trim();

    const allCommented = lines
      .filter((l) => l.trim())
      .every((l) => l.trimStart().startsWith(marker));

    const updated = lines
      .map((line) => {
        if (!line.trim()) {
          return line;
        }
        if (allCommented) {
          return line.replace(
            new RegExp(`^(\\s*)${marker.replace(/[/*]/g, '\\$&')}\\s?`),
            '$1'
          );
        }
        const indent = /^\s*/.exec(line)?.[0] ?? '';
        return `${indent}${token}${line.slice(indent.length)}`;
      })
      .join('\n');

    area.value =
      area.value.slice(0, start) + updated + area.value.slice(end);
    area.setSelectionRange(start, start + updated.length);
    this.repaint();
    this.onInput();
  }

  private duplicateLine(): void {
    const area = this.textarea;
    const { selectionStart, selectionEnd } = area;

    if (selectionStart !== selectionEnd) {
      const text = area.value.slice(selectionStart, selectionEnd);
      area.value =
        area.value.slice(0, selectionEnd) +
        text +
        area.value.slice(selectionEnd);
      area.setSelectionRange(selectionEnd, selectionEnd + text.length);
    } else {
      const { start, end } = this.lineRange();
      const line = area.value.slice(start, end);
      area.value =
        area.value.slice(0, end) + '\n' + line + area.value.slice(end);
      const caret = selectionStart + line.length + 1;
      area.setSelectionRange(caret, caret);
    }

    this.repaint();
    this.onInput();
  }

  private deleteLine(): void {
    const area = this.textarea;
    const { start, end } = this.lineRange();
    const cut = end < area.value.length ? end + 1 : end;
    area.value = area.value.slice(0, start) + area.value.slice(cut);
    area.setSelectionRange(start, start);
    this.repaint();
    this.onInput();
  }

  private moveLine(direction: -1 | 1): void {
    const area = this.textarea;
    const value = area.value;
    const { start, end } = this.lineRange();
    const block = value.slice(start, end);

    if (direction === -1) {
      if (start === 0) {
        return;
      }
      const prevStart = value.lastIndexOf('\n', start - 2) + 1;
      const prev = value.slice(prevStart, start - 1);
      area.value =
        value.slice(0, prevStart) +
        block +
        '\n' +
        prev +
        value.slice(end);
      area.setSelectionRange(prevStart, prevStart + block.length);
    } else {
      if (end >= value.length) {
        return;
      }
      let nextEnd = value.indexOf('\n', end + 1);
      if (nextEnd === -1) {
        nextEnd = value.length;
      }
      const next = value.slice(end + 1, nextEnd);
      area.value =
        value.slice(0, start) +
        next +
        '\n' +
        block +
        value.slice(nextEnd);
      const newStart = start + next.length + 1;
      area.setSelectionRange(newStart, newStart + block.length);
    }

    this.repaint();
    this.onInput();
  }

  private indentSelection(direction: -1 | 1): void {
    const area = this.textarea;
    const { start, end } = this.lineRange();
    const block = area.value.slice(start, end);
    const updated =
      direction === 1
        ? block.replace(/^/gm, INDENT)
        : block.replace(/^ {1,2}/gm, '');

    area.value =
      area.value.slice(0, start) + updated + area.value.slice(end);
    area.setSelectionRange(start, start + updated.length);
    this.repaint();
    this.onInput();
  }

  private selectWordOccurrence(): void {
    const area = this.textarea;
    const { selectionStart, selectionEnd, value } = area;

    if (selectionStart === selectionEnd) {
      const before = /[\w$]*$/.exec(value.slice(0, selectionStart))?.[0] ?? '';
      const after = /^[\w$]*/.exec(value.slice(selectionStart))?.[0] ?? '';
      if (before || after) {
        area.setSelectionRange(
          selectionStart - before.length,
          selectionStart + after.length
        );
      }
      return;
    }

    const term = value.slice(selectionStart, selectionEnd);
    const next = value.indexOf(term, selectionEnd);
    const target = next === -1 ? value.indexOf(term) : next;
    if (target >= 0 && target !== selectionStart) {
      area.setSelectionRange(target, target + term.length);
    }
  }

  setLanguage(language: Language): void {
    this.language = language;
    this.collapsed.clear();
    this.repaint();
  }

  getValue(): string {
    return this.textarea.value;
  }

  setValue(value: string): void {
    this.textarea.value = value;
    this.repaint();
  }

  setPlaceholder(text: string): void {
    this.textarea.placeholder = text;
  }

  focus(): void {
    this.textarea.focus();
  }

  /**
   * Grows the editor to fit its content so fold arrows are reachable without
   * scrolling inside a small box, up to a cap that keeps the pane usable.
   */
  private autoSize(): void {
    const MAX = 720;
    const MIN = 190;

    // The highlight layer is absolutely positioned, so its scrollHeight does
    // not reflect content. Measure the textarea by collapsing it first.
    // A hidden element reports zero, which would lock the editor at MIN.
    // Skip and re-measure once it becomes visible.
    if (this.element.offsetParent === null) {
      this.pendingResize = true;
      return;
    }

    const previous = this.textarea.style.height;
    this.textarea.style.height = '0px';
    const needed = this.textarea.scrollHeight;
    this.textarea.style.height = previous;

    if (needed === 0) {
      this.pendingResize = true;
      return;
    }

    this.pendingResize = false;
    const height = Math.min(MAX, Math.max(MIN, needed));

    if (this.element.style.height !== `${height}px`) {
      this.textarea.style.height = `${height}px`;
      this.element.style.height = `${height}px`;
    }
  }

  repaint(): void {
    const value = this.textarea.value;

    if (value === '') {
      this.code.textContent = '';
      const hint = document.createElement('span');
      hint.className = 'code-placeholder';
      hint.textContent = this.textarea.placeholder;
      this.code.appendChild(hint);
      this.regions = [];
      this.gutter.textContent = '';
      this.element.classList.remove('has-folding');
      this.autoSize();
      this.syncScroll();
      return;
    }

    this.code.innerHTML = highlight(
      value.endsWith('\n') ? `${value} ` : value,
      this.language
    );
    this.renderGutter();
    this.paintSelection();
    this.paintCaret();
    this.autoSize();
    this.syncScroll();
    this.paintedValue = value;
  }

  /**
   * Redraws only the caret and selection. Fold regions and arrow positions
   * depend on the text, not the selection, so a full repaint would re-measure
   * every arrow on each pointer move.
   */
  private repaintSelectionOnly(): void {
    const value = this.textarea.value;

    if (value === '' || value !== this.paintedValue) {
      this.repaint();
      return;
    }

    if (this.regions.length > 0 && isFoldable(this.language)) {
      this.applyFolds();
    } else {
      this.code.innerHTML = highlight(
        value.endsWith('\n') ? `${value} ` : value,
        this.language
      );
    }

    this.paintSelection();
    this.paintCaret();
    this.syncScroll();
  }

  /**
   * Draws fold arrows beside foldable lines. Collapsing hides the lines in the
   * highlight layer only; the textarea keeps the full text so nothing is lost.
   */
  private renderGutter(): void {
    this.gutter.textContent = '';

    if (!isFoldable(this.language)) {
      this.element.classList.remove('has-folding');
      return;
    }

    const value = this.textarea.value;
    this.regions = findFoldRegions(value, this.language);

    if (this.regions.length === 0) {
      this.element.classList.remove('has-folding');
      return;
    }

    this.element.classList.add('has-folding');

    this.applyFolds();
    this.positionArrows();
  }

  /**
   * Places a fold arrow beside each region opener, measured from where that
   * line actually renders. Lines can wrap, so a fixed row height is wrong.
   */
  private positionArrows(): void {
    this.gutter.textContent = '';

    if (this.regions.length === 0) {
      return;
    }

    const inner = el('div', { class: 'gutter-inner' });
    inner.style.height = `${this.pre.scrollHeight}px`;
    this.gutter.append(inner);

    const hidden = this.hiddenLineSet();
    const rendered: number[] = [];
    const lines = this.textarea.value.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!hidden.has(i)) {
        rendered.push(i);
      }
    }

    // Each rendered line is wrapped in a marker so its offset can be measured.
    const markers = this.code.querySelectorAll('.line-anchor');
    const layerTop = this.pre.getBoundingClientRect().top;

    markers.forEach((marker, index) => {
      const sourceLine = rendered[index];
      if (sourceLine === undefined) {
        return;
      }

      const region = this.regions.find((r) => r.start === sourceLine);
      if (!region) {
        return;
      }

      const first = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
      const top = first.top - layerTop + this.pre.scrollTop;

      const isCollapsed = this.collapsed.has(sourceLine);
      const cell = el('div', { class: 'gutter-cell foldable' });
      cell.classList.toggle('collapsed', isCollapsed);
      cell.style.top = `${top}px`;
      cell.title = isCollapsed ? 'Expand' : 'Collapse';

      // Span the region so its extent stays visible while scrolling through
      // long wrapped content.
      if (!isCollapsed) {
        const endIndex = rendered.indexOf(region.end);
        const endMarker =
          endIndex >= 0 ? (markers[endIndex] as HTMLElement | undefined) : undefined;
        if (endMarker) {
          const rects = endMarker.getClientRects();
          const last = rects[rects.length - 1] ?? endMarker.getBoundingClientRect();
          const bottom = last.bottom - layerTop + this.pre.scrollTop;
          const guide = el('div', { class: 'fold-guide' });
          guide.style.top = `${top + 16}px`;
          guide.style.height = `${Math.max(0, bottom - top - 18)}px`;
          inner.append(guide);
        }
      }

      cell.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (this.collapsed.has(sourceLine)) {
          this.collapsed.delete(sourceLine);
        } else {
          this.collapsed.add(sourceLine);
        }
        this.applyFolds();
        this.autoSize();
        this.positionArrows();
        this.paintSelection();
        this.paintCaret();
      });

      inner.append(cell);
    });

    this.autoSize();
  }

  private hiddenLineSet(): Set<number> {
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

  /** Hides collapsed lines in the highlight layer and dims them in the input. */
  private applyFolds(): void {
    const hidden = new Set<number>();
    for (const region of this.regions) {
      if (!this.collapsed.has(region.start)) {
        continue;
      }
      for (let i = region.start + 1; i <= region.end; i++) {
        hidden.add(i);
      }
    }

    const lines = this.textarea.value.split('\n');
    const parts: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (hidden.has(i)) {
        continue;
      }

      let text = lines[i];
      if (this.collapsed.has(i)) {
        const region = this.regions.find((r) => r.start === i);
        const count = region ? region.end - region.start : 0;
        text = `${text}  ⋯ ${count} lines`;
      }

      // The anchor lets the gutter measure where this line actually renders.
      parts.push(
        `<span class="line-anchor">${highlight(text, this.language)}</span>`
      );
    }

    this.code.innerHTML = parts.join('\n');
  }

  /**
   * The textarea's own selection is transparent so it cannot cover the
   * highlighted tokens; the visible band is drawn on the layer beneath.
   */
  /** Draws the caret on the layer, since the textarea itself is invisible. */
  private paintCaret(): void {
    const { selectionStart, selectionEnd } = this.textarea;
    if (
      selectionStart !== selectionEnd ||
      document.activeElement !== this.textarea
    ) {
      return;
    }

    const walker = document.createTreeWalker(this.code, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node = walker.nextNode() as Text | null;

    while (node) {
      const length = node.data.length;
      if (selectionStart <= offset + length) {
        const tail = node.splitText(selectionStart - offset);
        const caret = document.createElement('span');
        caret.className = 'caret-mark';
        tail.parentNode?.insertBefore(caret, tail);
        return;
      }
      offset += length;
      node = walker.nextNode() as Text | null;
    }

    const caret = document.createElement('span');
    caret.className = 'caret-mark';
    this.code.appendChild(caret);
  }

  private paintSelection(): void {
    const { selectionStart, selectionEnd } = this.textarea;
    if (
      selectionStart === selectionEnd ||
      document.activeElement !== this.textarea
    ) {
      return;
    }

    const walker = document.createTreeWalker(this.code, NodeFilter.SHOW_TEXT);
    const ranges: { node: Text; from: number; to: number }[] = [];
    let offset = 0;
    let node = walker.nextNode() as Text | null;

    while (node) {
      const length = node.data.length;
      const start = Math.max(selectionStart, offset);
      const end = Math.min(selectionEnd, offset + length);
      if (start < end) {
        ranges.push({ node, from: start - offset, to: end - offset });
      }
      offset += length;
      node = walker.nextNode() as Text | null;
    }

    for (const range of ranges.reverse()) {
      const target = range.node;
      const after = target.splitText(range.from);
      after.splitText(range.to - range.from);
      const band = document.createElement('span');
      band.className = 'sel-band';
      after.parentNode?.insertBefore(band, after);
      band.appendChild(after);
    }
  }

  private paintedValue: string | null = null;
  private lastSelection = '';

  private selectionFrame = 0;

  /** Coalesces drag updates to one paint per animation frame. */
  private scheduleSelectionPaint(): void {
    if (this.selectionFrame !== 0) {
      return;
    }
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = 0;
      this.paintOnSelectionChange();
    });
  }

  private paintOnSelectionChange(): void {
    const key = `${this.textarea.selectionStart}:${this.textarea.selectionEnd}`;
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.repaintSelectionOnly();
    }
  }

  /** Drag and track-click on the custom scrollbar, driving the textarea. */
  private wireScrollbar(): void {
    let dragging = false;
    let startY = 0;
    let startScroll = 0;

    const ratio = (): number => {
      const scrollable = this.textarea.scrollHeight - this.textarea.clientHeight;
      return scrollable > 0 ? scrollable : 0;
    };

    this.scrollThumb.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      startY = event.clientY;
      startScroll = this.textarea.scrollTop;
      this.scrollThumb.setPointerCapture(event.pointerId);
      this.scrollTrack.classList.add('dragging');
    });

    this.scrollThumb.addEventListener('pointermove', (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      const trackHeight = this.scrollTrack.clientHeight;
      const thumbHeight = this.scrollThumb.offsetHeight;
      const travel = trackHeight - thumbHeight;
      if (travel <= 0) {
        return;
      }
      const delta = event.clientY - startY;
      this.textarea.scrollTop = startScroll + (delta / travel) * ratio();
      this.syncScroll();
    });

    const stop = (event: PointerEvent): void => {
      if (!dragging) {
        return;
      }
      dragging = false;
      this.scrollThumb.releasePointerCapture(event.pointerId);
      this.scrollTrack.classList.remove('dragging');
    };
    this.scrollThumb.addEventListener('pointerup', stop);
    this.scrollThumb.addEventListener('pointercancel', stop);

    // Clicking the track jumps a page in that direction.
    this.scrollTrack.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.target === this.scrollThumb) {
        return;
      }
      const rect = this.scrollTrack.getBoundingClientRect();
      const above = event.clientY < this.scrollThumb.getBoundingClientRect().top;
      const page = this.textarea.clientHeight;
      this.textarea.scrollTop += above ? -page : page;
      void rect;
      this.syncScroll();
    });
  }

  /** Sizes and positions the thumb from the textarea's scroll state. */
  private syncScrollbar(): void {
    const contentHeight = this.textarea.scrollHeight;
    const viewHeight = this.textarea.clientHeight;

    if (contentHeight <= viewHeight + 1) {
      this.scrollTrack.classList.add('hidden');
      return;
    }
    this.scrollTrack.classList.remove('hidden');

    const trackHeight = this.scrollTrack.clientHeight;
    const MIN_THUMB = 24;
    const thumbHeight = Math.max(
      MIN_THUMB,
      Math.round((viewHeight / contentHeight) * trackHeight)
    );
    const travel = trackHeight - thumbHeight;
    const scrollable = contentHeight - viewHeight;
    const offset =
      scrollable > 0
        ? Math.round((this.textarea.scrollTop / scrollable) * travel)
        : 0;

    this.scrollThumb.style.height = `${thumbHeight}px`;
    this.scrollThumb.style.transform = `translateY(${offset}px)`;
  }

  private syncScroll(): void {
    this.syncScrollbar();
    this.pre.scrollTop = this.textarea.scrollTop;
    this.pre.scrollLeft = this.textarea.scrollLeft;
    // Arrow tops are absolute positions within the content, so the gutter is
    // scrolled rather than transformed — transforming would shift them twice.
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  /**
   * Word and line deletion, matching VS Code's bindings per platform:
   * Alt/Ctrl+Backspace deletes a word, Cmd+Backspace deletes to the line start
   * (macOS only, where Cmd is the line modifier).
   */
  private handleWordOrLineDelete(event: KeyboardEvent): boolean {
    const area = this.textarea;
    const { selectionStart, selectionEnd, value } = area;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const forward = event.key === 'Delete';

    const wordModifier = isMac ? event.altKey : event.ctrlKey;
    const lineModifier = isMac && event.metaKey;

    if (!wordModifier && !lineModifier) {
      return false;
    }

    // With a selection, every variant just removes it.
    if (selectionStart !== selectionEnd) {
      event.preventDefault();
      area.value = value.slice(0, selectionStart) + value.slice(selectionEnd);
      area.setSelectionRange(selectionStart, selectionStart);
      this.repaint();
      this.onInput();
      return true;
    }

    let from = selectionStart;
    let to = selectionStart;

    if (lineModifier) {
      if (forward) {
        const nl = value.indexOf('\n', selectionStart);
        to = nl === -1 ? value.length : nl;
      } else {
        from = value.lastIndexOf('\n', selectionStart - 1) + 1;
      }
    } else if (forward) {
      to = CodeEditor.wordBoundary(value, selectionStart, 1);
    } else {
      from = CodeEditor.wordBoundary(value, selectionStart, -1);
    }

    if (from === to) {
      return false;
    }

    event.preventDefault();
    area.value = value.slice(0, from) + value.slice(to);
    area.setSelectionRange(from, from);
    this.repaint();
    this.onInput();
    return true;
  }

  /**
   * Finds the next word edge, skipping trailing whitespace first so deleting
   * after a space removes the space and the word together, as VS Code does.
   */
  private static wordBoundary(
    value: string,
    from: number,
    direction: 1 | -1
  ): number {
    const isWord = (c: string): boolean => /[\w$]/.test(c);
    let i = from;

    if (direction === -1) {
      while (i > 0 && /\s/.test(value[i - 1]) && value[i - 1] !== '\n') {
        i--;
      }
      if (i > 0 && value[i - 1] === '\n') {
        return i - 1;
      }
      if (i > 0 && isWord(value[i - 1])) {
        while (i > 0 && isWord(value[i - 1])) {
          i--;
        }
      } else {
        while (i > 0 && !isWord(value[i - 1]) && !/\s/.test(value[i - 1])) {
          i--;
        }
      }
      return i;
    }

    while (i < value.length && /\s/.test(value[i]) && value[i] !== '\n') {
      i++;
    }
    if (i < value.length && value[i] === '\n') {
      return i + 1;
    }
    if (i < value.length && isWord(value[i])) {
      while (i < value.length && isWord(value[i])) {
        i++;
      }
    } else {
      while (i < value.length && !isWord(value[i]) && !/\s/.test(value[i])) {
        i++;
      }
    }
    return i;
  }

  private replaceSelection(text: string, selectionOffset: number): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    this.textarea.value =
      value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const caret = selectionStart + selectionOffset;
    this.textarea.setSelectionRange(caret, caret);
    this.repaint();
    this.onInput();
  }

  private onKeydown(event: KeyboardEvent): void {
    const area = this.textarea;
    const mod = event.metaKey || event.ctrlKey;

    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();

      if (key === '/') {
        event.preventDefault();
        this.toggleComment();
        return;
      }
      if (key === 'd') {
        event.preventDefault();
        this.selectWordOccurrence();
        return;
      }
      if (key === ']') {
        event.preventDefault();
        this.indentSelection(1);
        return;
      }
      if (key === '[') {
        event.preventDefault();
        this.indentSelection(-1);
        return;
      }
      if (event.shiftKey && key === 'k') {
        event.preventDefault();
        this.deleteLine();
        return;
      }
      if (event.shiftKey && key === 'd') {
        event.preventDefault();
        this.duplicateLine();
        return;
      }
    }

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (event.shiftKey) {
        this.duplicateLine();
      } else {
        this.moveLine(event.key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = area;

      if (selectionStart !== selectionEnd) {
        const startLine = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const block = value.slice(startLine, selectionEnd);

        const shifted = event.shiftKey
          ? block.replace(/^ {1,2}/gm, '')
          : block.replace(/^/gm, INDENT);

        area.value =
          value.slice(0, startLine) + shifted + value.slice(selectionEnd);
        area.setSelectionRange(startLine, startLine + shifted.length);
        this.repaint();
        this.onInput();
        return;
      }

      if (event.shiftKey) {
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const prefix = value.slice(lineStart, selectionStart);
        const trimmed = prefix.replace(/ {1,2}$/, '');
        if (trimmed !== prefix) {
          area.value =
            value.slice(0, lineStart) + trimmed + value.slice(selectionStart);
          const caret = selectionStart - (prefix.length - trimmed.length);
          area.setSelectionRange(caret, caret);
          this.repaint();
          this.onInput();
        }
        return;
      }

      this.replaceSelection(INDENT, INDENT.length);
      return;
    }

    // Auto-close quotes; typing the same quote at the caret steps over it.
    if (event.key === '"' || event.key === "'") {
      const { selectionStart, selectionEnd, value } = area;

      if (selectionStart === selectionEnd) {
        if (value[selectionStart] === event.key) {
          event.preventDefault();
          area.setSelectionRange(selectionStart + 1, selectionStart + 1);
          return;
        }

        const before = value[selectionStart - 1];
        // Don't pair inside a word or after an escape.
        if (before !== '\\' && !/[\w"']/.test(before ?? '')) {
          event.preventDefault();
          this.replaceSelection(event.key + event.key, 1);
          return;
        }
      } else {
        // Wrap the selection in quotes.
        event.preventDefault();
        const selected = value.slice(selectionStart, selectionEnd);
        area.value =
          value.slice(0, selectionStart) +
          event.key +
          selected +
          event.key +
          value.slice(selectionEnd);
        area.setSelectionRange(selectionStart + 1, selectionEnd + 1);
        this.repaint();
        this.onInput();
        return;
      }
    }

    const OPENERS: Record<string, string> = {
      '{': '}',
      '[': ']',
      '(': ')',
    };

    if (OPENERS[event.key]) {
      const { selectionStart, selectionEnd, value } = area;

      if (selectionStart === selectionEnd) {
        event.preventDefault();
        this.replaceSelection(event.key + OPENERS[event.key], 1);
        return;
      }

      event.preventDefault();
      const selected = value.slice(selectionStart, selectionEnd);
      area.value =
        value.slice(0, selectionStart) +
        event.key +
        selected +
        OPENERS[event.key] +
        value.slice(selectionEnd);
      area.setSelectionRange(selectionStart + 1, selectionEnd + 1);
      this.repaint();
      this.onInput();
      return;
    }

    // Typing a closing bracket where one already sits steps over it.
    // '>' is excluded here so XML tag completion below can handle it.
    if (
      event.key === '}' ||
      event.key === ']' ||
      event.key === ')'
    ) {
      const { selectionStart, selectionEnd, value } = area;
      if (
        selectionStart === selectionEnd &&
        value[selectionStart] === event.key
      ) {
        event.preventDefault();
        area.setSelectionRange(selectionStart + 1, selectionStart + 1);
        return;
      }
    }

    if (event.key === '>' && this.language === 'xml') {
      const { selectionStart, selectionEnd, value } = area;
      if (selectionStart === selectionEnd) {
        const before = value.slice(0, selectionStart);
        const open = /<([A-Za-z][\w:.-]*)(\s[^<>]*)?$/.exec(before);
        if (open && !open[0].startsWith('</') && !before.endsWith('/')) {
          event.preventDefault();
          const closing = `></${open[1]}>`;
          this.replaceSelection(closing, 1);
          return;
        }
      }
    }

    // Cmd/Ctrl+Enter is the send shortcut; let it bubble without inserting
    // a newline or auto-indenting.
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (this.handleWordOrLineDelete(event)) {
        return;
      }
    }

    if (event.key === 'Backspace') {
      const { selectionStart, selectionEnd, value } = area;
      if (selectionStart === selectionEnd && selectionStart > 0) {
        const before = value[selectionStart - 1];
        const after = value[selectionStart];
        const pairs: Record<string, string> = {
          '"': '"',
          "'": "'",
          '{': '}',
          '[': ']',
          '(': ')',
        };
        if (before && pairs[before] === after) {
          event.preventDefault();
          area.value =
            value.slice(0, selectionStart - 1) + value.slice(selectionStart + 1);
          area.setSelectionRange(selectionStart - 1, selectionStart - 1);
          this.repaint();
          this.onInput();
          return;
        }
      }
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter') {
      const { selectionStart, value } = area;
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const line = value.slice(lineStart, selectionStart);
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';

      const before = value[selectionStart - 1];
      const after = value[selectionStart];
      const betweenTags =
        before === '>' &&
        after === '<' &&
        /<\/[A-Za-z][\w:.-]*>$/.test(value.slice(selectionStart));
      const opensBlock =
        (before === '{' && after === '}') ||
        (before === '[' && after === ']') ||
        betweenTags;

      if (opensBlock) {
        event.preventDefault();
        const inner = `\n${indent}${INDENT}`;
        const closing = `\n${indent}`;
        this.replaceSelection(inner + closing, inner.length);
        return;
      }

      if (indent) {
        event.preventDefault();
        this.replaceSelection(`\n${indent}`, indent.length + 1);
      }
      return;
    }

    if (
      event.key === '}' ||
      event.key === ']'
    ) {
      const { selectionStart, selectionEnd, value } = area;
      if (selectionStart === selectionEnd && value[selectionStart] === event.key) {
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        if (!value.slice(lineStart, selectionStart).trim()) {
          event.preventDefault();
          area.setSelectionRange(selectionStart + 1, selectionStart + 1);
        }
      }
    }
  }
}
