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

function buildBranchGraph(index, family, { fusion, plan, expand = false, limit = 40 } = {}) {
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
  const trunk =
    (members.has(data.base) && data.base) ||
    reps[0]?.id ||
    [...ids].sort(
      (a, b) =>
        popularity(b) - popularity(a) ||
        pluginTime(index.plugins.get(a)) - pluginTime(index.plugins.get(b)) ||
        a.localeCompare(b),
    )[0];
  const caps = new Map(ids.map((id) => [id, labels(index.plugins.get(id))]));
  const parents = new Map(),
    reasons = new Map(),
    duplicates = new Set();
  const assign = (id, parent, reason, duplicate = false) => {
    if (id !== trunk && id !== parent && members.has(id) && members.has(parent) && !parents.has(id)) {
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
  for (const id of ids) assign(id, index.nodes.get(id)?.fork_of, 'fork_of');
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
    assign(id, trunk, 'inferred');
  }
  // Break a back edge deterministically and retain the reason for the repair.
  for (const id of ids) {
    const seen = new Set();
    let cursor = id;
    while (parents.has(cursor)) {
      seen.add(cursor);
      const next = parents.get(cursor);
      if (seen.has(next)) {
        parents.set(cursor, trunk);
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
      const plusCaps = id === trunk ? [] : difference(caps.get(id), trunkCaps);
      const minusCaps = id === trunk ? [] : difference(trunkCaps, caps.get(id));
      const unique = (caps.get(id) || [])
        .filter(
          (cap) =>
            !(siblings.get(parent) || []).some((other) => other !== id && caps.get(other).some((c) => matches(cap, c))),
        )
        .map((x) => x.label)
        .slice(0, 6);
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
        role: id === trunk ? 'trunk' : parent === trunk ? 'fork' : 'subfork',
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
  let shown = nodes,
    hidden = 0;
  limit = Math.max(1, Math.floor(Number(limit) || 40));
  if (!expand && nodes.length > limit) {
    const keep = new Set([trunk, ...reps.map((x) => x.id), ...suggested]);
    const ranked = [...nodes].sort(
      (a, b) => b.plus - a.plus || popularity(b.id) - popularity(a.id) || a.id.localeCompare(b.id),
    );
    // Reserve room for placeholders; mandatory nodes remain visible even if they exceed the requested limit.
    for (const n of ranked) if (keep.size < Math.max(1, limit - 1)) keep.add(n.id);
    const omitted = nodes.filter((n) => !keep.has(n.id));
    hidden = omitted.length;
    const groups = new Map();
    for (const n of omitted) {
      let parent = n.parent;
      while (parent && !keep.has(parent)) parent = parents.get(parent);
      parent ||= trunk;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(n);
    }
    // Combine excess groups under the trunk when the limit cannot fit all placeholders.
    const available = Math.max(1, limit - keep.size);
    if (groups.size > available) {
      const all = [...groups.values()].flat();
      groups.clear();
      groups.set(trunk, all);
    }
    shown = [
      ...nodes.filter((n) => keep.has(n.id)),
      ...[...groups].map(([parent, items], i) => ({
        id: `collapsed:${parent}:${i + 1}`,
        label: `另 ${items.length} 个分支`,
        role: 'collapsed',
        count: items.length,
        parent,
        time: items[0].time,
      })),
    ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  const visible = new Map(shown.map((n) => [n.id, n]));
  for (const [row, node] of shown.entries()) node.row = row;
  const children = new Map();
  for (const n of shown) {
    if (n.id === trunk) continue;
    let parent = n.parent;
    while (parent && !visible.has(parent)) parent = parents.get(parent);
    n.attach = parent && visible.has(parent) ? parent : null;
    if (n.attach) {
      if (!children.has(n.attach)) children.set(n.attach, []);
      children.get(n.attach).push(n.id);
    }
  }
  const lastUse = new Map();
  for (const n of shown) {
    const kids = children.get(n.id) || [];
    lastUse.set(n.id, kids.length ? Math.max(...kids.map((id) => visible.get(id).row)) : n.row);
  }
  const laneUntil = new Map([[0, shown.length]]);
  const laneById = new Map([[trunk, 0]]);
  let laneCount = 1;
  const lowestFree = (row) => {
    for (let lane = 1; lane < laneCount; lane++) if ((laneUntil.get(lane) ?? -1) < row) return lane;
    return laneCount++;
  };
  for (const node of shown) {
    if (node.id === trunk) {
      node.lane = 0;
      continue;
    }
    const lane = lowestFree(node.row);
    node.lane = lane;
    laneById.set(node.id, lane);
    laneUntil.set(lane, lastUse.get(node.id) ?? node.row);
  }
  const edges = [];
  for (const n of shown) {
    if (n.id === trunk || !n.attach) continue;
    edges.push({ from: n.attach, to: n.id, type: laneById.get(n.attach) === n.lane ? 'line' : 'fork' });
  }
  for (const id of suggested)
    if (visible.has(id) && visible.has(trunk)) edges.push({ from: id, to: trunk, type: 'merge-suggest' });
  return {
    family: family.id,
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
