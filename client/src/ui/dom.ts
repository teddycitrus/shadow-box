type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}`.trim(), type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

export const params = new URLSearchParams(location.search);
export const flag = (name: string) => params.get(name) === '1';

/** Keeps debug/keys/record flags when navigating. */
export function go(path: string): void {
  const keep = ['debug', 'keys', 'record'].filter(flag).map((f) => `${f}=1`).join('&');
  location.assign(keep ? `${path}?${keep}` : path);
}
