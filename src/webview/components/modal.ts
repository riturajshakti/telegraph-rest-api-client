import { el, clear } from '../dom';

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = el('div', { class: 'modal-host' }) as HTMLDivElement;
    document.body.append(host);
  }
  return host;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const root = ensureHost();
    clear(root);
    root.classList.add('open');

    const previouslyFocused = document.activeElement as HTMLElement | null;

    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      root.classList.remove('open');
      clear(root);
      document.removeEventListener('keydown', onKeydown, true);
      previouslyFocused?.focus();
      resolve(result);
    };

    const confirmBtn = el(
      'button',
      {
        type: 'button',
        class: `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`,
      },
      [options.confirmLabel ?? 'Confirm']
    ) as HTMLButtonElement;
    confirmBtn.addEventListener('click', () => finish(true));

    const cancelBtn = el(
      'button',
      { type: 'button', class: 'btn btn-ghost' },
      [options.cancelLabel ?? 'Cancel']
    ) as HTMLButtonElement;
    cancelBtn.addEventListener('click', () => finish(false));

    const body: (Node | string)[] = [
      el('div', { class: 'modal-message' }, [options.message]),
    ];
    if (options.detail) {
      body.push(el('div', { class: 'modal-detail' }, [options.detail]));
    }

    const dialog = el(
      'div',
      {
        class: 'modal',
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-label': options.title,
      },
      [
        el('div', { class: 'modal-title' }, [options.title]),
        el('div', { class: 'modal-body' }, body),
        el('div', { class: 'modal-actions' }, [cancelBtn, confirmBtn]),
      ]
    );

    const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        finish(false);
      }
    });

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === 'Tab') {
        const focusable = [cancelBtn, confirmBtn];
        const index = focusable.indexOf(
          document.activeElement as HTMLButtonElement
        );
        event.preventDefault();
        const next = event.shiftKey
          ? (index - 1 + focusable.length) % focusable.length
          : (index + 1) % focusable.length;
        focusable[next].focus();
      }
    };

    document.addEventListener('keydown', onKeydown, true);

    root.append(backdrop);
    confirmBtn.focus();
  });
}
