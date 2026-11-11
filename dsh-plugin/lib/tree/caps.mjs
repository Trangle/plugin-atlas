const UI = /面板|界面|侧栏|侧边栏|按钮|主题|皮肤|样式|视图|窗口|标签页|渲染|菜单|弹窗|\bui\b|panel|sidebar|theme|view/i;
const TOOL = /工具|命令|接口|api|mcp|调用|tool|command/i;
const normalize = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
const STOP_WORDS = new Set(
  [
    'dsh',
    'dsh plugin',
    'dsh-plugin',
    'plugin',
    'plugins',
    '插件',
    'deepseek',
    'deepseek harness',
    'harness',
    'cordis',
    'cordis plugin',
    'mcp',
    'tool',
    'tools',
    '工具',
    '扩展',
    'extension',
    'agent',
    '智能体',
  ].map(normalize),
);
const isNoise = (key) => !key || STOP_WORDS.has(key) || /^[a-z0-9]{1,2}$/.test(key);
const kind = (s, tool = false) => (tool ? 'tools' : UI.test(s) ? 'ui' : TOOL.test(s) ? 'tools' : 'other');
const empty = () => ({ ui: [], tools: [], other: [] });
const order = (a, b) => b.count - a.count || a.label.localeCompare(b.label);
function grams(value) {
  const chars = [...value];
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(1).map((c, i) => chars[i] + c));
}
function similar(a, b) {
  const x = grams(normalize(a)),
    y = grams(normalize(b));
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / (x.size + y.size - common) >= 0.6;
}
function item(label, count, group, ids = []) {
  const value = { label, capability: label, count, kind: group, provided_by: ids.slice(0, 8) };
  Object.defineProperty(value, '_providers', { value: new Set(ids), writable: true });
  return value;
}
function merge(map, key, entry) {
  const old = map.get(key);
  if (!old) {
    const copy = { ...entry, provided_by: [...entry.provided_by] };
    Object.defineProperty(copy, '_providers', {
      value: new Set(entry._providers || entry.provided_by),
      writable: true,
    });
    map.set(key, copy);
    return;
  }
  if (old.label !== entry.label || old._variants || entry._variants) {
    const variants = old._variants || new Map([[old.label, old.count]]);
    for (const [label, count] of entry._variants || [[entry.label, entry.count]])
      variants.set(label, (variants.get(label) || 0) + count);
    old._variants = variants;
    const [label] = [...variants].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    old.label = old.capability = label;
  }
  if (old._providers.size === old.count && (entry._providers?.size ?? entry.provided_by.length) === entry.count) {
    for (const id of entry._providers || entry.provided_by) old._providers.add(id);
    old.count = old._providers.size;
  } else {
    old.count += entry.count;
    for (const id of entry._providers || entry.provided_by) old._providers.add(id);
  }
  for (const id of entry.provided_by)
    if (old.provided_by.length < 8 && !old.provided_by.includes(id)) old.provided_by.push(id);
}
function pluginCaps(p) {
  const entries = new Map();
  const add = (label, forced) => {
    if (typeof label !== 'string') return;
    const key = normalize(label);
    if (isNoise(key)) return;
    const group = kind(label, forced);
    const previous = entries.get(key);
    if (!previous || forced) entries.set(key, item(label, 1, group, [p.id]));
  };
  for (const label of [...(p.provides || []), ...(p.capabilities || [])]) add(label, false);
  for (const tool of p.tools || []) add(typeof tool === 'string' ? tool : tool?.name, true);
  const groups = empty();
  for (const entry of entries.values()) groups[entry.kind].push(entry);
  return groups;
}
function groupEntries(map, limit = Infinity) {
  const result = empty();
  for (const entry of map.values()) {
    delete entry._variants;
    result[entry.kind].push(entry);
  }
  for (const group of Object.values(result)) {
    group.sort(order);
    if (group.length > limit) group.length = limit;
  }
  return result;
}
function flatten(groups) {
  return [...groups.ui, ...groups.tools, ...groups.other];
}
function detail(groups, unique, missing) {
  const totals = Object.fromEntries(['ui', 'tools', 'other'].map((key) => [key, groups[key].length]));
  totals.unique = unique.length;
  totals.missing = missing.length;
  return {
    ...Object.fromEntries(['ui', 'tools', 'other'].map((key) => [key, groups[key].slice(0, 12)])),
    unique: unique.slice(0, 12),
    missing: missing.slice(0, 12),
    totals,
  };
}

// Merge only the most frequent keys, using shared bigrams to find candidates.
function mergeSimilar(map) {
  const top = [...map.entries()].sort((a, b) => order(a[1], b[1])).slice(0, 200);
  const inverted = new Map(),
    representatives = new Map();
  for (const [key, entry] of top) {
    const gs = grams(key),
      candidates = new Set();
    for (const g of gs) for (const candidate of inverted.get(g) || []) candidates.add(candidate);
    let match;
    for (const candidate of candidates) {
      const rep = representatives.get(candidate);
      if (rep.entry.kind !== entry.kind) continue;
      let common = 0;
      for (const g of gs) if (rep.grams.has(g)) common++;
      if (common / (gs.size + rep.grams.size - common) >= 0.6) {
        match = candidate;
        break;
      }
    }
    if (match !== undefined) {
      merge(map, match, entry);
      map.delete(key);
    } else {
      representatives.set(key, { entry, grams: gs });
      for (const g of gs) {
        if (!inverted.has(g)) inverted.set(g, []);
        inverted.get(g).push(key);
      }
    }
  }
}
function buildTree({ graph, plugins, capabilities = {} }) {
  const nodes = new Map(),
    children = new Map(),
    pluginToLeaf = new Map(),
    caps = new Map(),
    pluginMap = new Map();
  for (const p of plugins) pluginMap.set(p.id, { ...p });
  for (const source of graph.nodes || []) {
    const { readme, README, ...fields } = source;
    nodes.set(source.id, { ...fields, children: [], pluginIds: new Set() });
  }
  for (const p of plugins)
    if (!nodes.has(p.id))
      nodes.set(p.id, {
        id: p.id,
        type: 'plugin',
        label: p.name || p.id,
        parent: p.branch_id,
        children: [],
        pluginIds: new Set(),
      });
  for (const n of nodes.values()) if (n.parent && nodes.has(n.parent)) nodes.get(n.parent).children.push(n.id);
  for (const n of nodes.values())
    if (n.type === 'branch') {
      for (const id of n.plugin_ids || []) {
        const child = nodes.get(id);
        if (child?.type === 'plugin' && !child.parent) {
          child.parent = n.id;
          n.children.push(id);
        }
      }
    }
  for (const n of nodes.values()) children.set(n.id, n.children);
  const pluginGroups = new Map(plugins.map((p) => [p.id, pluginCaps(p)]));
  const index = {
    nodes,
    children,
    pluginToLeaf,
    caps,
    plugins: pluginMap,
    capabilities,
    roots: [...nodes.values()].filter((n) => !n.parent || !nodes.has(n.parent)).map((n) => n.id),
  };
  const visiting = new Set(),
    built = new Set();
  function collect(n) {
    if (built.has(n.id) || visiting.has(n.id)) return;
    visiting.add(n.id);
    if (n.type === 'plugin') {
      const id = n.plugin_id || n.id;
      n.groups = pluginGroups.get(id) || empty();
      if (pluginMap.has(id)) n.pluginIds.add(id);
      if (nodes.get(n.parent)?.type === 'branch') pluginToLeaf.set(id, n.parent);
    } else {
      const direct = new Map(),
        combined = new Map();
      for (const id of n.children) {
        const child = nodes.get(id);
        collect(child);
        for (const pid of child.pluginIds) n.pluginIds.add(pid);
        const target = n.type === 'branch' && child.type === 'plugin' ? direct : combined;
        for (const entry of flatten(child.groups)) merge(target, normalize(entry.label), entry);
      }
      for (const id of n.plugin_ids || []) n.pluginIds.add(id);
      if (direct.size) mergeSimilar(direct);
      for (const [key, entry] of direct) merge(combined, key, entry);
      const data = capabilities instanceof Map ? capabilities.get(n.id) : capabilities[n.id];
      if (n.type === 'branch')
        for (const c of data?.union || []) {
          if (typeof c.capability !== 'string') continue;
          const key = normalize(c.capability);
          if (!isNoise(key))
            merge(
              combined,
              key,
              item(c.capability, Math.max(1, c.provided_by?.length || 0), kind(c.capability), c.provided_by || []),
            );
        }
      n.groups = groupEntries(combined);
    }
    caps.set(n.id, n.groups);
    visiting.delete(n.id);
    built.add(n.id);
  }
  for (const n of nodes.values()) collect(n);
  // Aggregate sibling presence once per parent, so every detail is linear in its own keys.
  for (const parent of nodes.values()) {
    const byType = new Map();
    for (const id of parent.children) {
      const child = nodes.get(id);
      if (child.type === 'plugin') continue;
      if (!byType.has(child.type)) byType.set(child.type, []);
      byType.get(child.type).push(child);
    }
    for (const siblings of byType.values()) prepareDetails(siblings);
  }
  for (const n of nodes.values())
    if (n.type !== 'plugin' && !n.detail)
      n.detail = detail(
        n.groups,
        flatten(n.groups)
          .filter((entry) => entry.count >= 2)
          .sort(order),
        [],
      );
  return index;
}
function prepareDetails(siblings) {
  const presence = new Map();
  for (const node of siblings)
    for (const entry of flatten(node.groups)) {
      const key = normalize(entry.label),
        old = presence.get(key);
      if (old) old.frequency++;
      else presence.set(key, { frequency: 1, entry });
    }
  for (const node of siblings) {
    const own = new Set(flatten(node.groups).map((entry) => normalize(entry.label)));
    const unique = flatten(node.groups)
      .filter((entry) => presence.get(normalize(entry.label)).frequency === 1 && entry.count >= 2)
      .sort(order);
    const threshold = Math.max(2, Math.ceil((siblings.length - 1) * 0.3));
    const missing = [];
    for (const [key, value] of presence)
      if (!own.has(key) && value.frequency >= threshold) missing.push({ ...value.entry, count: value.frequency });
    node.detail = detail(node.groups, unique, missing.sort(order));
  }
}
function nodeCaps(index, id) {
  const node = index.nodes.get(id);
  if (!node) return null;
  if (node.detail) return node.detail;
  const parent = index.nodes.get(node.parent);
  if (parent) {
    if (!parent._pluginPresence) {
      const siblings = parent.children
        .map((child) => index.nodes.get(child))
        .filter((child) => child.type === 'plugin');
      const presence = new Map();
      for (const sibling of siblings)
        for (const entry of flatten(sibling.groups)) {
          const key = normalize(entry.label),
            existing = presence.get(key);
          if (existing) existing.frequency++;
          else presence.set(key, { frequency: 1, entry });
        }
      parent._pluginPresence = { presence, count: siblings.length };
    }
    const { presence, count } = parent._pluginPresence;
    const entries = flatten(node.groups),
      own = new Set(entries.map((entry) => normalize(entry.label)));
    const unique = entries.filter((entry) => presence.get(normalize(entry.label)).frequency === 1).sort(order);
    const missing = [],
      threshold = Math.max(2, Math.ceil((count - 1) * 0.3));
    for (const [key, value] of presence)
      if (!own.has(key) && value.frequency >= threshold) missing.push({ ...value.entry, count: value.frequency });
    return (node.detail = detail(node.groups, unique, missing.sort(order)));
  }
  return (node.detail = detail(node.groups, flatten(node.groups).sort(order), []));
}
export { buildTree, nodeCaps, normalize, similar, pluginCaps };
