import { createHash } from 'node:crypto';
import { normalize, similar, pluginCaps } from './caps.mjs';

const groups = ['ui', 'tools', 'other'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const capData = (index, id) =>
  index.capabilities instanceof Map ? index.capabilities.get(id) : index.capabilities?.[id];
const membersOf = (family) => family.members || family.plugin_ids || [];
const entries = (p) => groups.flatMap((g) => pluginCaps(p)[g].map((x) => ({ ...x, group: g })));
function listFamilies(index, { branch, fusion } = {}) {
  const result = [];
  const leaves = [...index.nodes.values()].filter(
    (n) => n.type === 'branch' && !n.children.some((id) => index.nodes.get(id)?.type === 'branch'),
  );
  for (const leaf of leaves.sort((a, b) => a.id.localeCompare(b.id))) {
    if (branch && leaf.id !== branch) continue;
    const members = [...leaf.pluginIds].filter((id) => index.plugins.has(id)).sort();
    result.push({ id: leaf.id, branch: leaf.id, members });
    const parent = new Map(members.map((id) => [id, id]));
    const find = (id) => {
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
      return parent.get(id);
    };
    const join = (ids) => {
      const valid = ids.filter((id) => parent.has(id));
      for (const id of valid.slice(1)) parent.set(find(id), find(valid[0]));
    };
    for (const id of members) {
      const n = index.nodes.get(id),
        p = index.plugins.get(id);
      join([
        id,
        n?.fork_of,
        n?.duplicate_of,
        ...(n?.forks || []),
        ...(p?.merged_from || []).map((x) => (typeof x === 'string' ? x : x.id)),
      ]);
    }
    for (const cluster of capData(index, leaf.id)?.duplicates || []) join(cluster);
    const ops = fusion?.ops || fusion || {};
    for (const x of ops.fork || []) join([x.upstream, ...(x.forks || [])]);
    for (const x of ops.duplicate || []) join([x.keep, ...(x.duplicates || [])]);
    const clusters = new Map();
    for (const id of members) {
      const root = find(id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(id);
    }
    const sorted = [...clusters.values()].filter((x) => x.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach((ids, i) => result.push({ id: `dup:${leaf.id}:${i + 1}`, branch: leaf.id, members: ids }));
  }
  return result;
}
function resolveFamily(index, idOrPluginId) {
  if (idOrPluginId && typeof idOrPluginId === 'object') return idOrPluginId;
  const id = index.pluginToLeaf.get(idOrPluginId) || idOrPluginId;
  return listFamilies(index).find((f) => f.id === id) || null;
}
function unionOf(index, family) {
  const union = [];
  for (const id of membersOf(family))
    for (const e of entries(index.plugins.get(id) || { id })) {
      let found = union.find(
        (x) => x.group === e.group && (normalize(x.label) === normalize(e.label) || similar(x.label, e.label)),
      );
      if (!found) {
        found = { label: e.label, group: e.group, providers: [] };
        union.push(found);
      }
      if (!found.providers.includes(id)) found.providers.push(id);
    }
  return union;
}
function representatives(index, family, k = 3) {
  family = resolveFamily(index, family);
  if (!family) return [];
  const union = unionOf(index, family),
    ids = membersOf(family);
  const best = new Map();
  for (const item of capData(index, family.branch)?.union || [])
    if (item.best_impl) best.set(item.best_impl, (best.get(item.best_impl) || 0) + 1);
  const popularity = (id) =>
    Math.log1p(
      Math.max(0, Number(index.plugins.get(id)?.stars) || 0) +
        Math.max(0, Number(index.plugins.get(id)?.downloads) || 0),
    );
  const maxPop = Math.max(0, ...ids.map(popularity)),
    maxBest = Math.max(0, ...best.values());
  const dates = ids.map(
    (id) => Date.parse(index.plugins.get(id)?.updated_at || index.plugins.get(id)?.updated || '') || 0,
  );
  const minDate = Math.min(...dates),
    maxDate = Math.max(...dates);
  const ranked = ids
    .map((id, i) => ({
      id,
      score:
        0.5 * (union.length ? union.filter((x) => x.providers.includes(id)).length / union.length : 0) +
        0.2 * (maxPop ? popularity(id) / maxPop : 0) +
        0.2 * (maxBest ? (best.get(id) || 0) / maxBest : 0) +
        0.1 * (maxDate ? (maxDate === minDate ? 1 : (dates[i] - minDate) / (maxDate - minDate)) : 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = [],
    covered = new Set();
  for (const candidate of ranked) {
    const added = union.filter((x, i) => x.providers.includes(candidate.id) && !covered.has(i));
    if (selected.length && (!union.length || added.length / union.length < 0.15)) continue;
    selected.push(candidate);
    union.forEach((x, i) => {
      if (x.providers.includes(candidate.id)) covered.add(i);
    });
    if (selected.length >= Math.min(3, Math.max(1, k))) break;
  }
  return selected;
}
function draftPlan(index, family, { readmeOf } = {}) {
  family = resolveFamily(index, family);
  if (!family) throw new Error('找不到分叉族');
  const reps = representatives(index, family),
    base = reps[0]?.id || null,
    union = unionOf(index, family);
  const scores = new Map(representatives(index, family, 3).map((x) => [x.id, x.score]));
  const absorbMap = new Map();
  for (const cap of union.filter((x) => !x.providers.includes(base))) {
    const from = [...cap.providers].sort(
      (a, b) => (scores.get(b) || 0) - (scores.get(a) || 0) || a.localeCompare(b),
    )[0];
    if (!absorbMap.has(from)) absorbMap.set(from, { from, capabilities: [], reason: '补充基底缺失的能力' });
    absorbMap.get(from).capabilities.push(cap.label);
  }
  const conflicts = [];
  for (const cap of union) {
    const between = reps.map((x) => x.id).filter((id) => cap.providers.includes(id));
    if (between.length > 1)
      conflicts.push({
        [cap.group === 'tools' ? 'tool' : 'capability']: cap.label,
        between,
        note: '多个代表提供此功能，需比较实现',
      });
  }
  const deps = new Map();
  for (const id of membersOf(family)) {
    const p = index.plugins.get(id) || {};
    for (const dep of p.deps_dsh || []) {
      const value = typeof dep === 'string' ? dep : `${dep.name || ''}@${dep.version || dep.range || ''}`;
      const match = value.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/);
      if (!match) continue;
      if (!deps.has(match[1])) deps.set(match[1], []);
      deps.get(match[1]).push({ id, version: match[2] || '' });
    }
    for (const line of p.capability_red_lines || [])
      conflicts.push({
        red_line: typeof line === 'string' ? line : JSON.stringify(line),
        between: [id],
        note: '确认能力红线',
      });
  }
  for (const [dep, values] of deps)
    if (new Set(values.map((x) => x.version).filter(Boolean)).size > 1)
      conflicts.push({ dep, between: values.map((x) => x.id), note: '依赖版本要求不同，需检查兼容性' });
  const absorb = [...absorbMap.values()];
  return {
    family: family.id,
    members_count: membersOf(family).length,
    representatives: reps,
    base,
    absorb,
    conflicts,
    steps: [
      `以 ${base || '待选插件'} 为基底创建分叉`,
      ...absorb.map((x) => `从 ${x.from} 移植：${x.capabilities.join('、')}`),
      '处理实现、工具、依赖及能力红线冲突',
      '去重并整理能力并集',
      '测试并编写迁移说明',
    ],
    dedup_union: Object.fromEntries(groups.map((g) => [g, union.filter((x) => x.group === g).map((x) => x.label)])),
  };
}
function familyFingerprint(index, family, readmeHash = () => '') {
  family = resolveFamily(index, family);
  if (!family) throw new Error('找不到分叉族');
  return hash(
    JSON.stringify(
      [...membersOf(family)].sort().map((id) => {
        const p = index.plugins.get(id) || {};
        const caps = entries(p)
          .map((x) => `${x.group}:${normalize(x.label)}`)
          .sort();
        return [id, readmeHash(p) || '', p.version || '', hash(JSON.stringify(caps))];
      }),
    ),
  );
}
export { listFamilies, resolveFamily, representatives, draftPlan, familyFingerprint };
