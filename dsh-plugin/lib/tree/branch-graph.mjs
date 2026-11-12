import { createHash } from 'node:crypto';
import { normalize, similar, pluginCaps } from './caps.mjs';
import { listFamilies, resolveFamily, representatives } from './families.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pluginTime = (p = {}) => {
  for (const key of ['created_at', 'pushed_at', 'published_at', 'updated_at']) {
    const time = Date.parse(p[key]);
    if (Number.isFinite(time)) return time;
  }
  return 0;
};
const repo = (p) =>
  String(p.repo || '')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .pop()
    .toLowerCase();

const STOP_TOKENS = new Set([
  'dsh',
  'plugin',
  'plugins',
  'deepseek',
  'harness',
  'the',
  'for',
  'and',
  'web',
  'cordis',
  'client',
  'that',
  'this',
  'with',
  'from',
  'github',
  'npm',
  'only',
  'com',
  'org',
  'www',
  'http',
  'https',
  'package',
  'null',
  'into',
  'its',
  'one',
  'your',
  'you',
  'are',
  'was',
  'were',
  'has',
  'have',
  'been',
  'can',
  'will',
  'just',
  'also',
  'than',
  'then',
  'when',
  'what',
  'which',
  'their',
  'they',
  'them',
  'not',
  'but',
  'use',
  'using',
  'used',
  'all',
  'any',
  'our',
  'out',
  'new',
  'old',
  'more',
  'most',
  'some',
  'such',
  'about',
  'over',
  'after',
  'before',
  'other',
  'like',
  'make',
  'made',
  'get',
  'got',
  'better',
]);
const ZH_TERMS = [
  '工作区',
  '会话',
  '侧栏',
  '侧边栏',
  '面板',
  '折叠',
  '置顶',
  '搜索',
  '菜单',
  '分组',
  '归档',
  '主题',
  '状态',
  '偏好',
  '排序',
  '拖拽',
  '隐藏',
  '列表',
  '设置',
  '入口',
  '浮层',
  '导航',
  '工具栏',
  '标签',
  '文件夹',
];
const tokensOf = (p, extra = []) => {
  const text = [
    p?.name,
    p?.package,
    repo(p),
    p?.summary,
    p?.description,
    p?.description_en,
    ...(Array.isArray(p?.keywords) ? p.keywords : []),
    ...extra,
  ]
    .map((x) => String(x || ''))
    .join(' ');
  const lower = text.toLowerCase();
  return [
    ...lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((x) => x.length >= 3 && !STOP_TOKENS.has(x) && !/^\d+$/.test(x)),
    ...ZH_TERMS.filter((term) => text.includes(term)),
  ];
};
const clusterCache = new Map();
const labels = (p) => {
  const groups = pluginCaps(p);
  const result = Object.values(groups)
    .flat()
    .map((x) => ({ label: x.label, group: x.kind }));
  // Short capability names are valid graph labels even though the tree suppresses them as noise.
  for (const value of [...(p.provides || []), ...(p.capabilities || [])])
    if (typeof value === 'string' && /^[a-z0-9]{1,2}$/i.test(normalize(value)))
      result.push({ label: value, group: 'other' });
  return result;
};
const matches = (a, b) =>
  a.group === b.group && (normalize(a.label) === normalize(b.label) || similar(a.label, b.label));
const difference = (a, b) => a.filter((x) => !b.some((y) => matches(x, y))).map((x) => x.label);

function buildBranchGraph(index, family, { fusion, plan, expand = false, expandClusters = [], limit = 40 } = {}) {
  if (typeof family !== 'object' || !family) {
    family = listFamilies(index, { fusion }).find((f) => f.id === family) || resolveFamily(index, family);
  }
  if (!family) return null;
  const ids = [...new Set(family.members || family.plugin_ids || [])].filter((id) => index.plugins.has(id));
  const members = new Set(ids),
    data = plan?.plan || plan?.draft || plan || {};
  const reps = representatives(index, family);
  const popularity = (id) =>
    (Number(index.plugins.get(id)?.stars) || 0) + (Number(index.plugins.get(id)?.downloads) || 0);
  let trunk;
  const caps = new Map(ids.map((id) => [id, labels(index.plugins.get(id))]));
  const parents = new Map(),
    reasons = new Map(),
    duplicates = new Set();
  const assign = (id, parent, reason, duplicate = false) => {
    if (id !== parent && members.has(id) && members.has(parent) && !parents.has(id)) {
      parents.set(id, parent);
      reasons.set(id, reason);
      if (duplicate) duplicates.add(id);
    }
  };
  const ops = fusion?.ops || fusion || {};
  for (const id of ids) assign(id, index.nodes.get(id)?.duplicate_of, 'duplicate_of', true);
  for (const op of ops.duplicate || []) for (const id of op.duplicates || []) assign(id, op.keep, 'duplicate', true);
  const capData =
    index.capabilities instanceof Map ? index.capabilities.get(family.branch) : index.capabilities?.[family.branch];
  for (const group of capData?.duplicates || [])
    for (const id of group.slice(1)) assign(id, group[0], 'duplicates', true);
  for (const id of ids) {
    assign(id, index.nodes.get(id)?.fork_of, 'fork_of');
    for (const child of index.nodes.get(id)?.forks || [])
      assign(typeof child === 'string' ? child : child?.id, id, 'forks');
  }
  for (const op of ops.fork || []) for (const id of op.forks || []) assign(id, op.upstream, 'fusion fork');
  for (const id of ids)
    for (const source of index.plugins.get(id)?.merged_from || [])
      assign(typeof source === 'string' ? source : source?.id, id, 'merged_from');
  for (const id of ids) {
    const p = index.plugins.get(id);
    if (p.gh_fork && repo(p)) {
      const candidates = ids.filter(
        (other) => other !== id && !index.plugins.get(other).gh_fork && repo(index.plugins.get(other)) === repo(p),
      );
      if (candidates.length === 1) assign(id, candidates[0], 'gh_fork');
    }
  }
  const packages = new Map();
  for (const id of ids) {
    const name = index.plugins.get(id)?.package;
    if (typeof name === 'string' && name) {
      if (!packages.has(name)) packages.set(name, []);
      packages.get(name).push(id);
    }
  }
  for (const group of packages.values()) {
    const roots = group.filter((id) => !parents.has(id) && !index.plugins.get(id)?.gh_fork);
    if (roots.length === 1) for (const id of group) assign(id, roots[0], 'npm package');
  }
  // Remove cycles before choosing a root.
  for (const id of ids) {
    const seen = new Set();
    let cursor = id;
    while (parents.has(cursor)) {
      seen.add(cursor);
      const next = parents.get(cursor);
      if (seen.has(next)) {
        parents.delete(cursor);
        reasons.set(cursor, '检测到环，已断开回边');
        break;
      }
      cursor = next;
    }
  }
  const rootOf = (id) => {
    while (parents.has(id)) id = parents.get(id);
    return id;
  };
  const treeSizes = new Map();
  for (const id of ids) {
    const root = rootOf(id);
    treeSizes.set(root, (treeSizes.get(root) || 0) + 1);
  }
  const rank = (a, b) =>
    popularity(b) - popularity(a) ||
    caps.get(b).length - caps.get(a).length ||
    pluginTime(index.plugins.get(a)) - pluginTime(index.plugins.get(b)) ||
    a.localeCompare(b);
  const isCapability =
    !String(family.id).startsWith('dup:') &&
    ids.some((id) => !parents.has(id) && (treeSizes.get(id) || 0) === 1) &&
    ids.length > 1;
  let clusters = [];
  if (isCapability) {
    const key = hash([
      family.id,
      [...ids]
        .sort()
        .map((id) => [
          id,
          caps.get(id),
          parents.get(id),
          reasons.get(id),
          popularity(id),
          pluginTime(index.plugins.get(id)),
        ]),
    ]);
    clusters = clusterCache.get(key);
    if (!clusters) {
      const familyTokens = new Set(
        [
          ...String(family.id)
            .toLowerCase()
            .split(/[^a-z0-9\u4e00-\u9fff]+/),
          ...(String(family.id).includes('sidebar') ? ['侧栏', '侧边栏'] : []),
        ].filter(Boolean),
      );
      const sets = new Map(
        ids.map((id) => [
          id,
          new Set(
            [
              ...caps.get(id).map((c) => normalize(c.label)),
              ...tokensOf(index.plugins.get(id)).filter((x) => !familyTokens.has(x)),
            ].filter(Boolean),
          ),
        ]),
      );
      const freq = new Map();
      for (const set of sets.values()) for (const label of set) freq.set(label, (freq.get(label) || 0) + 1);
      const choices = (id) =>
        [...sets.get(id)]
          .filter((x) => freq.get(x) >= 2 && freq.get(x) <= ids.length * (ids.length >= 30 ? 0.7 : 0.5))
          .sort((a, b) => freq.get(b) - freq.get(a) || a.localeCompare(b));
      const groups = new Map();
      for (const id of [...ids].sort()) {
        const label = choices(id)[0] || '其他';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(id);
      }
      const splitOversized = () => {
        for (const [label, group] of [...groups])
          if (group.length > Math.max(12, ids.length * 0.25)) {
            const sub = new Map();
            for (const id of group) {
              const second = (label === '其他' ? choices(id) : choices(id).filter((x) => x !== label))[0];
              const name = second ? (label === '其他' ? second : `${label} · ${second}`) : label;
              if (!sub.has(name)) sub.set(name, []);
              sub.get(name).push(id);
            }
            if (sub.size > 1) {
              groups.delete(label);
              for (const [name, items] of sub) groups.set(name, items);
            }
          }
      };
      splitOversized();
      const jaccard = (a, b) => {
        const intersection = [...a].filter((x) => b.has(x)).length;
        return intersection / (a.size + b.size - intersection || 1);
      };
      for (const [label, group] of [...groups])
        if (group.length === 1 && label !== '其他') {
          const id = group[0];
          let best = '其他',
            score = 0.2;
          for (const [name, candidates] of groups)
            if (name !== label)
              for (const other of candidates) {
                const similarity = jaccard(sets.get(id), sets.get(other));
                if (similarity > score) {
                  score = similarity;
                  best = name;
                }
              }
          if (best !== label) {
            groups.delete(label);
            if (!groups.has(best)) groups.set(best, []);
            groups.get(best).push(id);
          }
        }
      splitOversized();
      const merged = new Map(groups);
      const leftovers = [];
      for (const [label, group] of [...merged])
        if (group.length < 3 && label !== '其他') {
          leftovers.push(...group);
          merged.delete(label);
        }
      if (leftovers.length) {
        if (!merged.has('其他')) merged.set('其他', []);
        merged.get('其他').push(...leftovers);
      }
      clusters = [...merged]
        .filter(([, group]) => group.length)
        .map(([label, group]) => ({
          id: hash(label).slice(0, 12),
          label,
          representative: [...group].sort(rank)[0],
          size: group.length,
          members: group,
        }))
        .sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
      clusterCache.set(key, clusters);
      if (clusterCache.size > 100) clusterCache.delete(clusterCache.keys().next().value);
    }
  }
  if (clusters.length > 12) {
    const copy = clusters.map((c) => ({ ...c, members: [...c.members] }));
    const head = copy.slice(0, 11);
    const extra = copy.slice(11).flatMap((c) => c.members);
    const existing = head.find((c) => c.label === '其他');
    if (existing) {
      existing.members = [...existing.members, ...extra];
      existing.size = existing.members.length;
      existing.representative = [...existing.members].sort(rank)[0];
      clusters = head;
    } else {
      clusters = [
        ...head,
        { id: 'other', label: '其他', members: extra, size: extra.length, representative: [...extra].sort(rank)[0] },
      ];
    }
  }
  const realParents = new Map(parents);
  const largestRoot = [...treeSizes]
    .filter(([, size]) => size > 1)
    .sort((a, b) => b[1] - a[1] || rank(a[0], b[0]))[0]?.[0];
  trunk =
    (isCapability ? clusters[0]?.representative : (members.has(data.base) && data.base) || largestRoot) ||
    reps[0]?.id ||
    [...ids].sort(rank)[0];
  // A chosen anchor cannot also have a parent.
  parents.delete(trunk);
  const clusterById = new Map();
  for (const cluster of clusters) for (const id of cluster.members) clusterById.set(id, cluster);
  if (isCapability) {
    for (const cluster of clusters) {
      const representative = cluster.representative;
      if (representative !== trunk && !parents.has(representative)) assign(representative, trunk, '能力簇');
      for (const id of cluster.members)
        if (id !== trunk && id !== representative && !parents.has(id)) assign(id, representative, '能力簇');
    }
  } else for (const id of ids) if (id !== trunk && !parents.has(id)) assign(id, trunk, '族内关联');
  // Break a back edge deterministically and retain the reason for the repair.
  for (const id of ids) {
    const seen = new Set();
    let cursor = id;
    while (parents.has(cursor)) {
      seen.add(cursor);
      const next = parents.get(cursor);
      if (seen.has(next)) {
        parents.delete(cursor);
        reasons.set(cursor, 'inferred：检测到环，已断开回边');
        break;
      }
      cursor = next;
    }
  }
  const siblings = new Map();
  for (const [id, parent] of parents) {
    if (!siblings.has(parent)) siblings.set(parent, []);
    siblings.get(parent).push(id);
  }
  const trunkCaps = caps.get(trunk) || [];
  const suggested = new Set(
    (data.absorb || [])
      .filter((x) => members.has(x.from) && x.from !== trunk && x.capabilities?.length)
      .map((x) => x.from),
  );
  const nodes = ids
    .map((id) => {
      const p = index.plugins.get(id),
        parent = parents.get(id) || null;
      const cluster = clusterById.get(id);
      const baseline =
        id === trunk
          ? id
          : realParents.get(id) ||
            (isCapability && cluster?.representative === id ? id : cluster?.representative || parent || trunk);
      const baseCaps = caps.get(baseline) || [];
      const plusCaps = baseline === id ? [] : difference(caps.get(id), baseCaps);
      const minusCaps = baseline === id ? [] : difference(baseCaps, caps.get(id));
      const unique = (caps.get(id) || [])
        .filter(
          (cap) =>
            !(siblings.get(parent) || []).some((other) => other !== id && caps.get(other).some((c) => matches(cap, c))),
        )
        .map((x) => x.label);
      const old = Date.parse(p.updated_at),
        baseDate = Date.parse(index.plugins.get(trunk)?.updated_at);
      const dead =
        (!caps.get(id).length && !popularity(id)) ||
        (p.relevance === 'suspect' &&
          Number.isFinite(old) &&
          Number.isFinite(baseDate) &&
          baseDate - old > 180 * 86400000 &&
          (Number(p.stars) || 0) < 2);
      return {
        id,
        label: p.name || index.nodes.get(id)?.label || id,
        time: pluginTime(p),
        parent,
        baseline,
        cluster: clusterById.get(id)?.id || null,
        clusterLabel: clusterById.get(id)?.label || null,
        clusterSize: cluster?.representative === id ? cluster.size : 0,
        baselineLabel: index.plugins.get(baseline)?.name || baseline,
        role:
          id === trunk
            ? 'trunk'
            : isCapability && cluster?.representative === id
              ? 'cluster-head'
              : parent === trunk
                ? 'fork'
                : 'subfork',
        status: duplicates.has(id) ? 'duplicate' : dead ? 'dead' : 'active',
        unique,
        plus: plusCaps.length,
        minus: minusCaps.length,
        plusCaps,
        minusCaps,
        reason: reasons.get(id) || '',
      };
    })
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const fingerprint = hash([
    ids
      .slice()
      .sort()
      .map((id) => [id, pluginTime(index.plugins.get(id)), index.plugins.get(id).version || '', hash(caps.get(id))]),
    trunk,
    plan || null,
  ]);
  const visibleTime = (items, id) => items.find((n) => n.id === id)?.time || 0;
  let shown = nodes,
    hidden = 0;
  limit = Math.min(12, Math.max(1, Math.floor(Number(limit) || 40)));
  if (!isCapability && expand !== true && expand !== '1' && nodes.length > limit) {
    const keep = new Set([
      trunk,
      ...(isCapability ? clusters.map((x) => x.representative) : reps.map((x) => x.id)),
      ...(isCapability ? [] : suggested),
    ]);
    const ranked = [...nodes].sort(
      (a, b) =>
        Number(suggested.has(b.id)) - Number(suggested.has(a.id)) ||
        b.plus - a.plus ||
        popularity(b.id) - popularity(a.id) ||
        a.id.localeCompare(b.id),
    );
    // Reserve room for placeholders; mandatory nodes remain visible even if they exceed the requested limit.
    if (isCapability) {
      const queues = clusters.map((cluster) => ranked.filter((n) => n.cluster === cluster.id && !keep.has(n.id)));
      while (keep.size < Math.max(keep.size, limit - clusters.length) && queues.some((queue) => queue.length)) {
        for (const queue of queues) {
          if (keep.size >= limit - clusters.length) break;
          if (queue.length) keep.add(queue.shift().id);
        }
      }
    } else for (const n of ranked) if (keep.size < Math.max(1, limit - 1)) keep.add(n.id);
    const omitted = nodes.filter((n) => !keep.has(n.id));
    hidden = omitted.length;
    const groups = new Map();
    for (const n of omitted) {
      let parent = isCapability ? clusterById.get(n.id)?.representative : n.parent;
      while (parent && !keep.has(parent)) parent = parents.get(parent);
      parent ||= trunk;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(n);
    }
    // Combine excess groups under the trunk when the limit cannot fit all placeholders.
    const available = Math.max(1, limit - keep.size);
    if (!isCapability && groups.size > available) {
      const all = [...groups.values()].flat();
      groups.clear();
      groups.set(trunk, all);
    }
    shown = [
      ...nodes.filter((n) => keep.has(n.id)),
      ...[...groups].map(([parent, items], i) => ({
        id: isCapability ? `collapsed:cluster:${clusterById.get(items[0].id).id}` : `collapsed:${parent}:${i + 1}`,
        label: isCapability
          ? `另 ${items.length} 个：${clusterById.get(items[0].id).label}`
          : `另 ${items.length} 个分支`,
        cluster: clusterById.get(items[0].id)?.id || null,
        clusterLabel: clusterById.get(items[0].id)?.label || null,
        role: 'collapsed',
        count: items.length,
        parent,
        time: Math.max(...items.map((n) => n.time), visibleTime(nodes, parent)),
      })),
    ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  if (isCapability) {
    const selected = new Set(typeof expandClusters === 'string' ? expandClusters.split(',') : expandClusters);
    if (typeof expand === 'string' && expand.startsWith('cluster:')) selected.add(expand.slice(8));
    const all = expand === true || expand === '1';
    const byId = new Map(nodes.map((n) => [n.id, n]));
    shown = clusters.flatMap((cluster) => {
      const head = byId.get(cluster.representative);
      head.expanded = all || selected.has(cluster.id);
      const members = nodes.filter((n) => n.cluster === cluster.id && n.id !== head.id);
      if (head.expanded || !members.length) return [head, ...(head.expanded ? members : [])];
      return [
        head,
        {
          id: `collapsed:cluster:${cluster.id}`,
          label: `+${members.length} · ${cluster.label.replaceAll(' · ', '·')} 簇`,
          clusterLabel: cluster.label,
          cluster: cluster.id,
          role: 'collapsed',
          count: members.length,
          parent: head.id,
          time: Math.max(head.time + 0.001, ...members.map((n) => n.time)),
        },
      ];
    });
    hidden = shown.filter((n) => n.role === 'collapsed').reduce((sum, n) => sum + n.count, 0);
  }
  shown.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const visible = new Map(shown.map((n) => [n.id, n]));
  for (const n of shown) {
    if (n.id === trunk) continue;
    let parent = n.parent;
    const seen = new Set([n.id]);
    while (parent && !visible.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = parents.get(parent);
    }
    if (seen.has(parent)) parent = null;
    n.attach = parent && visible.has(parent) ? parent : null;
  }
  const ordered = [],
    visiting = new Set(),
    placed = new Set();
  const place = (node) => {
    if (placed.has(node.id)) return;
    visiting.add(node.id);
    if (node.attach) {
      if (visiting.has(node.attach)) node.attach = null;
      else place(visible.get(node.attach));
    }
    visiting.delete(node.id);
    placed.add(node.id);
    ordered.push(node);
  };
  for (const node of shown) place(node);
  shown = ordered;
  for (const [row, node] of shown.entries()) node.row = row;
  const clusterLanes = new Map();
  let laneCount = 1;
  if (isCapability) {
    const ranges = clusters
      .map((cluster) => {
        const rows = shown.filter((node) => node.cluster === cluster.id).map((node) => node.row);
        return { cluster, start: Math.min(...rows), end: Math.max(...rows) };
      })
      .sort((a, b) => a.start - b.start);
    const occupiedUntil = [Infinity];
    for (const { cluster, start, end } of ranges) {
      if (cluster.members.includes(trunk)) {
        clusterLanes.set(cluster.id, 0);
        continue;
      }
      let lane = 1;
      while (occupiedUntil[lane] !== undefined && occupiedUntil[lane] >= start) lane++;
      occupiedUntil[lane] = end;
      clusterLanes.set(cluster.id, lane);
      laneCount = Math.max(laneCount, lane + 1);
    }
  }
  for (const node of shown) {
    if (node.id === trunk) node.lane = 0;
    else if (isCapability && node.cluster) node.lane = clusterLanes.get(node.cluster);
    else {
      node.lane = 1;
      laneCount = Math.max(laneCount, 2);
    }
  }
  const edges = [];
  const segment = (from, to, type) => {
    const a = visible.get(from),
      b = visible.get(to);
    if (!a || !b || a.row >= b.row) return;
    const bendRow = b.row - 1;
    if (a.row !== bendRow)
      edges.push({ from, to, type: 'line', fromRow: a.row, toRow: bendRow, fromLane: a.lane, toLane: a.lane });
    edges.push({
      from,
      to,
      type: a.lane === b.lane ? 'line' : type,
      fromRow: bendRow,
      toRow: b.row,
      fromLane: a.lane,
      toLane: b.lane,
    });
  };
  for (const n of shown) if (n.id !== trunk && n.attach) segment(n.attach, n.id, 'fork');
  for (const id of suggested) if (visible.has(id) && visible.has(trunk)) segment(id, trunk, 'merge-suggest');
  return {
    family: family.id,
    kind: isCapability ? 'capability' : 'fork',
    clusters: clusters.map(({ id, label, representative, size }) => ({ id, label, representative, size })),
    trunk,
    nodes: shown,
    edges,
    lanes: Math.max(1, laneCount),
    rows: shown.length,
    truncated: hidden > 0,
    hidden,
    fingerprint,
  };
}
export { pluginTime, buildBranchGraph };
