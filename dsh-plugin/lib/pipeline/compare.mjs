import path from 'node:path';
import { readLines, readJson } from '../io.mjs';

function grams(s) {
  const chars = [...String(s || '')],
    counts = new Map();
  for (let i = 0; i + 1 < chars.length; i++) {
    const key = chars[i] + chars[i + 1];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
const repo = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^(?:https?:\/\/|git@)github\.com[:/]/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
function similarity(a, b) {
  if ((repo(a.repo) && repo(a.repo) === repo(b.repo)) || (a.package && a.package === b.package)) return 1;
  const x = new Set(a.capabilities || []),
    y = new Set(b.capabilities || []),
    union = new Set([...x, ...y]);
  const jac = union.size ? [...x].filter((v) => y.has(v)).length / union.size : 0;
  const g = grams(a.summary),
    h = grams(b.summary);
  let dot = 0,
    aa = 0,
    bb = 0;
  for (const [k, v] of g) {
    dot += v * (h.get(k) || 0);
    aa += v * v;
  }
  for (const v of h.values()) bb += v * v;
  return (jac + (aa && bb ? dot / Math.sqrt(aa * bb) : 0)) / 2;
}
const verdict = (score) => (score >= 0.85 ? 'duplicate' : score >= 0.6 ? 'similar' : 'peer');
const name = (p) => `${p.name || p.id}（${p.id}）`;
async function compare(cfg, { ids = [], branchId, limit = 10 } = {}) {
  const [all, graph] = await Promise.all([
    readLines(path.join(cfg.dataDir, 'plugins.jsonl')),
    readJson(path.join(cfg.dataDir, 'graph.json'), { nodes: [] }),
  ]);
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const branches = [...nodes.values()].filter((n) => n.type === 'branch');
  const ancestry = (node) => {
    const result = [],
      seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      result.unshift(node);
      node = nodes.get(node.parent);
    }
    return result;
  };
  const depth = (node) => ancestry(node).length;
  const inTree = (node, parent) => ancestry(node).some((n) => n.id === parent.id);
  const branchFor = (p) =>
    nodes.get(p.branch_id)?.type === 'branch'
      ? nodes.get(p.branch_id)
      : branches.filter((n) => (n.plugin_ids || []).includes(p.id)).sort((a, b) => depth(b) - depth(a))[0];
  const members = (branch) => {
    const descendants = branches.filter((n) => inTree(n, branch));
    const idsInGraph = new Set(descendants.flatMap((n) => n.plugin_ids || []));
    const branchIds = new Set(descendants.map((n) => n.id));
    return all.filter((p) => branchIds.has(p.branch_id) || (!p.branch_id && idsInGraph.has(p.id)));
  };
  const capsFor = async (branch, categoryId) => {
    let node = branch;
    while (node?.type === 'branch') {
      const found = await readJson(path.join(cfg.dataDir, 'capabilities', categoryId, `${node.id}.json`), null);
      if (found) return found;
      node = nodes.get(node.parent);
    }
    return await readJson(path.join(cfg.dataDir, 'capabilities', `${categoryId}.json`), null);
  };
  const capLines = (caps, target) =>
    (caps?.union || [])
      .slice(0, 12)
      .map(
        (c) =>
          `${c.capability} · ${(c.provided_by || []).length} · ${c.best_impl || '无'}${target && (c.provided_by || []).includes(target) ? ' · 目标提供' : ''}${target && c.best_impl === target ? ' · 目标最佳实现' : ''}`,
      );
  const branchPath = (branch) =>
    ancestry(branch)
      .filter((n) => n.type !== 'root')
      .map((n) => n.label || n.id)
      .join(' > ');
  const pairs = [];
  if (branchId) {
    const branch = nodes.get(branchId);
    if (!branch || branch.type !== 'branch') {
      const q = branchId.toLowerCase();
      const suggestions = branches
        .filter((n) => n.id.toLowerCase().includes(q) || q.includes(n.id.toLowerCase()))
        .sort(
          (a, b) =>
            Number(b.id.toLowerCase().startsWith(q)) - Number(a.id.toLowerCase().startsWith(q)) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 5)
        .map((n) => n.id);
      const error = `分支不存在：${branchId}${suggestions.length ? `；相近分支：${suggestions.join('、')}` : ''}`;
      return { ok: false, error, suggestions, text: error };
    }
    const plugins = members(branch);
    const categoryId = ancestry(branch).find((n) => n.type === 'category')?.id || plugins[0]?.category_id;
    const capabilities = categoryId ? await capsFor(branch, categoryId) : null;
    for (let i = 0; i < plugins.length; i++)
      for (let j = i + 1; j < plugins.length; j++) {
        const a = plugins[i],
          b = plugins[j];
        if (plugins.length > 400 && !(a.capabilities || []).some((c) => (b.capabilities || []).includes(c))) continue;
        const score = similarity(a, b);
        if (score >= 0.85) pairs.push({ ids: [a.id, b.id], similarity: score, verdict: verdict(score) });
      }
    pairs.sort((a, b) => b.similarity - a.similarity || a.ids.join().localeCompare(b.ids.join()));
    pairs.splice(20);
    const lines = [
      `分支：${branchPath(branch)} · 插件数：${plugins.length}`,
      '能力全集：',
      ...capLines(capabilities),
      'best_impl 列表：',
      ...(capabilities?.union || []).filter((c) => c.best_impl).map((c) => `${c.capability} · ${c.best_impl}`),
      '疑似重复对：',
      ...pairs.map((p) => `${p.ids.join(' / ')} · ${p.similarity.toFixed(2)} · ${p.verdict}`),
    ];
    return { plugins, pairs, capabilities, text: lines.join('\n') };
  }
  const targets = [],
    lines = [];
  for (const id of ids) {
    const target = all.find((p) => p.id === id);
    if (!target) {
      lines.push(`插件不存在：${id}`);
      continue;
    }
    const branch = branchFor(target);
    if (!branch) {
      lines.push(`目标：${name(target)} · 未找到分支`);
      continue;
    }
    let scope = branch,
      plugins = members(scope);
    while (plugins.length < 5 && nodes.get(scope.parent)?.type === 'branch') {
      scope = nodes.get(scope.parent);
      plugins = members(scope);
    }
    const peers = plugins
      .filter((p) => p.id !== id && (!target.category_id || p.category_id === target.category_id))
      .map((plugin) => {
        const score = similarity(target, plugin);
        return { plugin, similarity: score, verdict: verdict(score) };
      })
      .sort((a, b) => b.similarity - a.similarity || a.plugin.id.localeCompare(b.plugin.id))
      .slice(0, Math.max(0, Math.floor(Number(limit) || 10)));
    const categoryId = target.category_id || ancestry(branch).find((n) => n.type === 'category')?.id;
    const capabilities = categoryId ? await capsFor(branch, categoryId) : null;
    targets.push({ target, branch: branch.id, scope: scope.id, peers, capabilities });
    lines.push(
      `目标：${name(target)} · ${branchPath(branch)}`,
      ...peers.map((p) => `${name(p.plugin)} · ${p.similarity.toFixed(2)} · ${p.verdict}`),
      '能力全集：',
      ...capLines(capabilities, id),
    );
  }
  const matrix = targets.map(({ target: a }) => targets.map(({ target: b }) => (a.id === b.id ? 1 : similarity(a, b))));
  if (targets.length > 1)
    lines.push(
      '相似度矩阵：',
      `ID · ${targets.map((t) => t.target.id).join(' · ')}`,
      ...targets.map((t, i) => `${t.target.id} · ${matrix[i].map((v) => v.toFixed(2)).join(' · ')}`),
    );
  if (!ids.length) return { ok: false, error: '请提供插件 ID 或分支 ID', text: '请提供插件 ID 或分支 ID' };
  return { targets, matrix, text: lines.join('\n'), ok: targets.length > 0 };
}
export { compare, similarity };
