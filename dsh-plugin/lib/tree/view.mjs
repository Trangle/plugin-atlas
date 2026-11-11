import { nodeCaps, normalize } from './caps.mjs';
function pathFor(index, node) {
  const result = [],
    seen = new Set();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    result.unshift({ id: node.id, label: node.label || node.id });
    node = index.nodes.get(node.parent);
  }
  return result;
}
function locate(index, query) {
  const q = normalize(query);
  if (!q) return [];
  return [...index.nodes.values()]
    .filter((node) => {
      const p = index.plugins.get(node.plugin_id || node.id);
      return [
        node.id,
        node.label,
        p?.name,
        ...Object.values(node.groups)
          .flat()
          .map((c) => c.capability),
      ].some((s) => normalize(s).includes(q));
    })
    .map((node) => ({ id: node.id, label: node.label || node.id, path: pathFor(index, node) }));
}
function subtree(index, id, depth = Infinity) {
  const n = index.nodes.get(id);
  if (!n) return null;
  const { children, pluginIds, groups, detail, _built, ...fields } = n;
  return {
    ...fields,
    pluginCount: pluginIds.size,
    caps: nodeCaps(index, id),
    children: depth > 0 ? children.map((c) => subtree(index, c, depth - 1)) : [],
  };
}
function renderTree(index, { root, depth = Infinity, caps = false, query } = {}) {
  const roots = root ? [root] : query ? locate(index, query).map((x) => x.id) : index.roots;
  const lines = [];
  function visit(id, prefix, last, level, top) {
    const n = index.nodes.get(id);
    if (!n) return;
    const c = nodeCaps(index, id);
    lines.push(
      `${prefix}${top ? '' : last ? '└─ ' : '├─ '}${n.label || id} [${n.pluginIds.size}] ui:${c.ui.length} tools:${c.tools.length} 独有:${c.unique.length} 缺失:${c.missing.length}`,
    );
    if (caps)
      for (const group of ['ui', 'tools', 'other'])
        if (c[group].length) lines.push(`${prefix}  ${group}: ${c[group].map((x) => x.capability).join('、')}`);
    if (level >= depth) return;
    n.children.forEach((child, i) =>
      visit(child, prefix + (top ? '' : last ? '   ' : '│  '), i === n.children.length - 1, level + 1, false),
    );
  }
  roots.forEach((id) => visit(id, '', true, 0, true));
  return lines.join('\n');
}
export { renderTree, locate, subtree };
