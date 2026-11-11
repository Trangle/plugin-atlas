import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalize } from './caps.mjs';
import { similarity } from '../pipeline/compare.mjs';
import { json, readJson, readLines, stamp as makeStamp, write } from '../io.mjs';

const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const grams = (s) => {
  const chars = [...normalize(s)],
    result = new Set();
  if (chars.length === 1) result.add(chars[0]);
  for (let i = 1; i < chars.length; i++) result.add(chars[i - 1] + chars[i]);
  return result;
};
const jaccard = (a, b) => {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return a.size + b.size - common ? common / (a.size + b.size - common) : 0;
};
const capabilitiesOf = (p) =>
  [
    ...(p.capabilities || []),
    ...(p.provides || []),
    ...(p.tools || []).map((t) => (typeof t === 'string' ? t : t?.name)),
  ].filter((x) => typeof x === 'string');
const repoName = (p) =>
  String(p.repo || '')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .pop()
    .toLowerCase();
const rank = (a, b) =>
  (Number(b.stars) || 0) + (Number(b.downloads) || 0) - (Number(a.stars) || 0) - (Number(a.downloads) || 0) ||
  a.id.localeCompare(b.id);
const capValues = (caps) => (caps instanceof Map ? [...caps.values()] : Object.values(caps || {}));
const ids = (items) => new Set((items || []).map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean));

function planTreeSync({
  graph,
  plugins,
  capabilities = {},
  dedupMerged = [],
  filteredOut = [],
  readmeHash = () => null,
  previousFingerprints = {},
  limit,
}) {
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const branchParents = new Set([...nodes.values()].filter((n) => n.type === 'branch').map((n) => n.parent));
  const leaves = [...nodes.values()].filter((n) => n.type === 'branch' && !branchParents.has(n.id));
  const leafIds = new Set(leaves.map((n) => n.id)),
    current = new Map(),
    mounted = new Set();
  for (const n of nodes.values()) for (const id of n.plugin_ids || []) mounted.add(id);
  for (const n of leaves) for (const id of n.plugin_ids || []) if (!current.has(id)) current.set(id, n.id);
  const excluded = ids(filteredOut);
  for (const id of ids(dedupMerged)) excluded.add(id);
  const visible = plugins.filter((p) => !excluded.has(p.id) && !['filtered', 'irrelevant'].includes(p.relevance));
  const byId = new Map(visible.map((p) => [p.id, p])),
    hashes = new Map(),
    fingerprints = {};
  for (const p of visible) {
    const h = readmeHash(p) || null;
    hashes.set(p.id, h);
    fingerprints[p.id] = `${h}|${p.version ?? ''}|${hash('sha1', JSON.stringify([...(p.capabilities || [])].sort()))}`;
  }
  const previous = previousFingerprints || {};
  const changed = { added: [], updated: [], removed: [] };
  for (const id of Object.keys(fingerprints)) {
    if (!(id in previous)) changed.added.push(id);
    else if (previous[id] !== fingerprints[id]) changed.updated.push(id);
  }
  for (const id of Object.keys(previous)) if (!(id in fingerprints)) changed.removed.push(id);
  const changedIds = new Set([...changed.added, ...changed.updated, ...changed.removed]);
  const ops = { attach: [], move: [], fork: [], duplicate: [] };
  if (!changedIds.size)
    return { ops, changed, fingerprints, counts: Object.fromEntries(Object.keys(ops).map((k) => [k, 0])) };
  const affected = new Set();
  for (const id of changedIds) {
    if (current.has(id)) affected.add(current.get(id));
    const p = byId.get(id);
    if (p && leafIds.has(p.branch_id)) affected.add(p.branch_id);
  }
  const capGet = (id) => (capabilities instanceof Map ? capabilities.get(id) : capabilities[id]);
  const branchData = new Map();
  for (const leaf of leaves) {
    const keys = new Set((capGet(leaf.id)?.union || []).map((c) => normalize(c.capability)).filter(Boolean));
    const words = grams(`${leaf.label || leaf.id} ${leaf.summary || ''}`);
    for (const id of leaf.plugin_ids || []) {
      const p = byId.get(id);
      if (!p) continue;
      for (const c of capabilitiesOf(p)) keys.add(normalize(c));
      for (const g of grams(`${p.name || ''} ${p.summary || p.description || ''}`)) words.add(g);
    }
    branchData.set(leaf.id, { keys, words });
  }
  const bestFor = (p, cur) => {
    const keys = new Set(capabilitiesOf(p).map(normalize).filter(Boolean));
    const words = grams(`${p.name || ''} ${p.summary || p.description || ''}`);
    const score = (id) => {
      const data = branchData.get(id);
      if (!data) return 0;
      const bound = (a, b) => (a.size && b.size ? Math.min(a.size, b.size) / Math.max(a.size, b.size) : 0);
      if (cur && id !== cur && (bound(keys, data.keys) + bound(words, data.words)) / 2 < 0.5) return 0;
      return (jaccard(keys, data.keys) + jaccard(words, data.words)) / 2;
    };
    let best = leaves[0]?.id,
      bestScore = score(best);
    for (const leaf of leaves) {
      const value = score(leaf.id);
      if (value > bestScore) {
        best = leaf.id;
        bestScore = value;
      }
    }
    return { best, bestScore, currentScore: score(cur) };
  };
  for (const p of visible) {
    if (!changedIds.has(p.id)) continue;
    const cur = current.get(p.id);
    if (!mounted.has(p.id)) {
      const match = leafIds.has(p.branch_id) ? { best: p.branch_id, bestScore: 1 } : bestFor(p);
      if (match.best) {
        ops.attach.push({
          id: p.id,
          to: match.best,
          score: match.bestScore,
          reason: leafIds.has(p.branch_id) ? '指定叶分支' : '能力和名称描述相似度最高',
          plugin: { id: p.id, name: p.name, summary: p.summary, github_only: p.github_only },
        });
        affected.add(match.best);
      }
    } else if (cur) {
      if (leafIds.has(p.branch_id) && cur !== p.branch_id)
        ops.move.push({ id: p.id, from: cur, to: p.branch_id, reason: '指定叶分支与当前归属不同' });
      else {
        const match = bestFor(p, cur);
        if (match.best !== cur && match.bestScore >= 0.5 && match.bestScore - match.currentScore >= 0.25)
          ops.move.push({
            id: p.id,
            from: cur,
            to: match.best,
            score: match.bestScore,
            reason: '目标分支相似度显著更高',
          });
      }
    }
  }
  // Union related pairs into stable groups, retaining the evidence for each group.
  function groups(pairs, fork) {
    const parent = new Map(),
      evidence = [];
    const find = (id) => {
      if (!parent.has(id)) parent.set(id, id);
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
      return parent.get(id);
    };
    for (const [a, b, why] of pairs) {
      if (!byId.has(a) || !byId.has(b) || a === b) continue;
      parent.set(find(a), find(b));
      evidence.push([a, b, why]);
    }
    const clusters = new Map();
    for (const id of parent.keys()) {
      const root = find(id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(byId.get(id));
    }
    const clusterEvidence = new Map();
    for (const [a, , why] of evidence) {
      const root = find(a);
      if (!clusterEvidence.has(root)) clusterEvidence.set(root, new Set());
      clusterEvidence.get(root).add(why);
    }
    return [...clusters.values()]
      .filter((ps) => ps.some((p) => changedIds.has(p.id) || affected.has(current.get(p.id))))
      .map((ps) => {
        ps.sort(
          fork
            ? (a, b) =>
                Number(!!a.gh_fork) - Number(!!b.gh_fork) ||
                (Number(b.stars) || 0) - (Number(a.stars) || 0) ||
                a.id.localeCompare(b.id)
            : rank,
        );
        const why = [...(clusterEvidence.get(find(ps[0].id)) || [])];
        return fork
          ? { upstream: ps[0].id, forks: ps.slice(1).map((p) => p.id), evidence: why }
          : { keep: ps[0].id, duplicates: ps.slice(1).map((p) => p.id), evidence: why };
      });
  }
  const forkPairs = [],
    repoGroups = new Map();
  for (const p of visible) {
    const repo = repoName(p);
    if (repo) {
      if (!repoGroups.has(repo)) repoGroups.set(repo, []);
      repoGroups.get(repo).push(p);
    }
    for (const entry of p.merged_from || []) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (id) forkPairs.push([p.id, id, 'merged_from']);
    }
  }
  for (const ps of repoGroups.values()) {
    const upstream = ps.filter((p) => p.gh_fork !== true).sort(rank)[0];
    if (upstream)
      for (const p of ps)
        if (p.gh_fork === true) forkPairs.push([upstream.id, p.id, 'gh_fork 且存在同基名非 fork 上游']);
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i],
          b = ps[j];
        const ah = hashes.get(a.id),
          bh = hashes.get(b.id);
        if (ah && ah === bh) forkPairs.push([a.id, b.id, '仓库基名及 README 全文哈希相同']);
        else if (!ah && !bh && jaccard(grams(a.description), grams(b.description)) >= 0.9)
          forkPairs.push([a.id, b.id, '仓库基名相同、README 均缺失且 description 二元组 Jaccard ≥ 0.9']);
      }
  }
  ops.fork = groups(forkPairs, true);
  const duplicatePairs = [],
    members = new Map();
  for (const p of visible) {
    const leaf = current.get(p.id) || (leafIds.has(p.branch_id) ? p.branch_id : null);
    if (leaf) {
      if (!members.has(leaf)) members.set(leaf, []);
      members.get(leaf).push(p);
    }
  }
  const byHash = new Map();
  for (const p of visible) {
    const h = hashes.get(p.id);
    if (h) {
      if (byHash.has(h)) duplicatePairs.push([byHash.get(h), p.id, 'README 哈希相同']);
      else byHash.set(h, p.id);
    }
  }
  const capSets = new Map(visible.map((p) => [p.id, new Set(p.capabilities || [])]));
  const sameRepo = (p) =>
    String(p.repo || '')
      .toLowerCase()
      .replace(/^git\+/, '')
      .replace(/^(?:https?:\/\/|git@)github\.com[:/]/, '')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
  const repos = new Map(visible.map((p) => [p.id, sameRepo(p)]));
  for (const [leaf, ps] of members) {
    if (!affected.has(leaf)) continue;
    const postings = new Map(),
      capPostings = new Map(),
      repoPostings = new Map(),
      packagePostings = new Map();
    const addPosting = (map, key, i) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(i);
    };
    for (let i = 0; i < ps.length; i++) {
      const candidates = new Set();
      if (ps.length <= 400) for (let j = 0; j < i; j++) candidates.add(j);
      else {
        const eligible = new Set();
        for (const c of capSets.get(ps[i].id)) for (const j of capPostings.get(c) || []) eligible.add(j);
        for (const j of repoPostings.get(repos.get(ps[i].id)) || []) eligible.add(j);
        for (const j of packagePostings.get(ps[i].package) || []) eligible.add(j);
        for (const g of grams(ps[i].name))
          for (const j of postings.get(g) || []) if (eligible.has(j)) candidates.add(j);
      }
      for (const j of candidates) {
        const a = ps[i],
          b = ps[j],
          x = capSets.get(a.id),
          y = capSets.get(b.id);
        const identical =
          (repos.get(a.id) && repos.get(a.id) === repos.get(b.id)) || (a.package && a.package === b.package);
        if (!identical && (!x.size || !y.size || Math.min(x.size, y.size) / Math.max(x.size, y.size) < 0.7)) continue;
        if (similarity(a, b) >= 0.85) duplicatePairs.push([a.id, b.id, '插件相似度 ≥ 0.85']);
      }
      if (ps.length > 400) {
        for (const g of grams(ps[i].name)) addPosting(postings, g, i);
        for (const c of capSets.get(ps[i].id)) addPosting(capPostings, c, i);
        addPosting(repoPostings, repos.get(ps[i].id), i);
        addPosting(packagePostings, ps[i].package, i);
      }
    }
  }
  for (const cap of capValues(capabilities))
    for (const group of cap?.duplicates || [])
      for (let i = 1; i < group.length; i++) duplicatePairs.push([group[0], group[i], '能力文件 duplicates']);
  ops.duplicate = groups(duplicatePairs, false);
  if (Number.isFinite(limit)) {
    const maximum = Math.max(0, Math.floor(limit));
    const truncated = Object.values(ops).some((items) => items.length > maximum);
    for (const key of Object.keys(ops)) ops[key] = ops[key].slice(0, maximum);
    if (truncated) {
      for (const id of Object.keys(fingerprints)) delete fingerprints[id];
      Object.assign(fingerprints, previous);
    }
  }
  return { ops, changed, fingerprints, counts: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v.length])) };
}

async function savePatch(stateDir, patch) {
  const file = path.join(stateDir, 'tree', `patch-${makeStamp()}.json`);
  await json(file, patch);
  return file;
}
async function treeHistory(stateDir) {
  return readLines(path.join(stateDir, 'tree', 'journal.jsonl'));
}
async function appendJournal(stateDir, entry) {
  const file = path.join(stateDir, 'tree', 'journal.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + '\n');
}
async function resolveExisting(dir) {
  return fs.realpath(dir).catch((error) => {
    if (error.code === 'ENOENT') return path.resolve(dir);
    throw error;
  });
}
async function applyTreePatch({ dataDir, stateDir, patch, allowProduction = false, productionDataDir }) {
  const resolved = await fs.realpath(dataDir);
  if (!allowProduction) {
    for (const dir of [].concat(productionDataDir || []).filter(Boolean)) {
      if ((await resolveExisting(dir)) === resolved)
        throw new Error('拒绝写入生产数据，需 --allow-production 并经用户确认');
    }
  }
  const file = path.join(resolved, 'graph.json'),
    original = await fs.readFile(file),
    graph = JSON.parse(original);
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const branches = new Set([...nodes.values()].filter((n) => n.type === 'branch').map((n) => n.parent));
  const leaf = (id) => nodes.get(id)?.type === 'branch' && !branches.has(id);
  const chain = (id) => {
    const result = [],
      seen = new Set();
    while (nodes.has(id) && !seen.has(id)) {
      seen.add(id);
      const node = nodes.get(id);
      result.push(node);
      id = node.parent;
    }
    return result;
  };
  const add = (node, id) => {
    node.plugin_ids ||= [];
    if (!node.plugin_ids.includes(id)) node.plugin_ids.push(id);
  };
  const edges = (graph.edges ||= []);
  for (const op of [...(patch.ops?.attach || []), ...(patch.ops?.move || [])]) {
    if (!leaf(op.to)) throw new Error(`目标不是叶分支：${op.to}`);
    const moving = (patch.ops?.move || []).includes(op);
    if (moving && !leaf(op.from)) throw new Error(`原分支不是叶分支：${op.from}`);
    const target = new Set(chain(op.to).map((n) => n.id));
    if (moving)
      for (const n of chain(op.from))
        if (!target.has(n.id)) n.plugin_ids = (n.plugin_ids || []).filter((id) => id !== op.id);
    for (const n of chain(op.to)) add(n, op.id);
    let node = nodes.get(op.id);
    if (!node) {
      const p = op.plugin || {};
      node = {
        id: op.id,
        type: 'plugin',
        label: p.name || op.id,
        parent: op.to,
        summary: p.summary || '',
        plugin_ids: [op.id],
        plugin_id: op.id,
        github_only: !!p.github_only,
      };
      graph.nodes.push(node);
      nodes.set(op.id, node);
    } else {
      node.parent = op.to;
      add(node, op.id);
    }
    for (let i = edges.length - 1; i >= 0; i--)
      if (edges[i].target === op.id && edges[i].type === 'parent') edges.splice(i, 1);
    edges.push({ source: op.to, target: op.id, type: 'parent', weight: 1 });
  }
  for (const op of patch.ops?.fork || []) {
    const upstream = nodes.get(op.upstream);
    if (upstream) upstream.forks = [...new Set([...(upstream.forks || []), ...op.forks])];
    for (const id of op.forks) if (nodes.get(id) && op.upstream) nodes.get(id).fork_of = op.upstream;
  }
  for (const op of patch.ops?.duplicate || [])
    for (const id of op.duplicates) if (nodes.get(id)) nodes.get(id).duplicate_of = op.keep;
  const stamp = makeStamp(),
    backup = path.join(stateDir, 'tree', 'backups', stamp, 'graph.json');
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, original);
  const output = JSON.stringify(graph, null, 2) + '\n',
    before = hash('sha256', original),
    after = hash('sha256', output);
  await write(file, output);
  const counts = Object.fromEntries(
    ['attach', 'move', 'fork', 'duplicate'].map((k) => [k, patch.ops?.[k]?.length || 0]),
  );
  await appendJournal(stateDir, { stamp, ops: counts, before, after });
  if (patch.fingerprints) await json(path.join(stateDir, 'tree', 'fingerprints.json'), patch.fingerprints);
  return { stamp, ops: counts, before, after, backup };
}
async function rollbackTree({ dataDir, stateDir, stamp }) {
  const history = await treeHistory(stateDir);
  const entry = stamp
    ? history.find((x) => x.stamp === stamp && x.before && x.after && !x.rollback)
    : [...history].reverse().find((x) => x.before && x.after && !x.rollback);
  if (!entry || !/^[\w-]+$/.test(entry.stamp)) throw new Error('找不到树备份');
  const backup = await fs.readFile(path.join(stateDir, 'tree', 'backups', entry.stamp, 'graph.json'));
  if (hash('sha256', backup) !== entry.before) throw new Error('备份哈希与 journal 不一致');
  const file = path.join(dataDir, 'graph.json'),
    before = hash('sha256', await fs.readFile(file));
  await write(file, backup);
  const after = hash('sha256', await fs.readFile(file));
  if (after !== entry.before) throw new Error('恢复后的哈希与 journal 不一致');
  const record = { stamp: makeStamp(), rollback: entry.stamp, before, after };
  await appendJournal(stateDir, record);
  return record;
}
export { planTreeSync, applyTreePatch, rollbackTree, treeHistory, savePatch };
