type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = String(value);
    } else if (key === 'value') {
      (node as HTMLInputElement).value = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}
