// Update existing nodes so a live snapshot does not replace focus, selection, or scroll state.
const previous = new WeakMap();
const keyOf = (node) =>
  node.nodeType === 1
    ? (node.getAttribute('data-key') ??
      (node.id || node.getAttribute('data-id') || node.getAttribute('data-project')))
    : null;

function compatible(a, b) {
  return a?.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

function patchNode(node, next) {
  if (node.nodeType === 3 || node.nodeType === 8) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  for (const attr of [...node.attributes]) {
    if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
  }
  for (const attr of next.attributes) {
    if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  }
  patchChildren(node, next);
}

function patchChildren(parent, next) {
  const keyed = new Map([...parent.childNodes].filter(keyOf).map((node) => [keyOf(node), node]));
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const key = keyOf(desired);
    const candidate = key ? keyed.get(key) : cursor;
    const node = compatible(candidate, desired) ? candidate : desired.cloneNode(true);
    if (node !== cursor) parent.insertBefore(node, cursor);
    if (node === candidate) patchNode(node, desired);
    cursor = node.nextSibling;
  }
  while (cursor) {
    const nextNode = cursor.nextSibling;
    cursor.remove();
    cursor = nextNode;
  }
}

export function patchHTML(root, html) {
  if (previous.get(root) === html) return false;
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  const focused = root.contains(root.ownerDocument.activeElement)
    ? root.ownerDocument.activeElement
    : null;
  const focusedAgent = focused?.closest('[data-id]')?.getAttribute('data-id');
  patchChildren(root, template.content);
  if (focused?.isConnected && root.ownerDocument.activeElement !== focused)
    focused.focus({ preventScroll: true });
  else if (focused && !focused.isConnected && focusedAgent) {
    [...root.querySelectorAll('[data-id]')]
      .find((node) => node.getAttribute('data-id') === focusedAgent)
      ?.focus({ preventScroll: true });
  }
  previous.set(root, html);
  return true;
}
