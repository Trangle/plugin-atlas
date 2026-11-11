import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planTreeSync, applyTreePatch, rollbackTree, treeHistory, savePatch } from '../lib/tree/fusion.mjs';

const graph = {
  nodes: [
    { id: 'root', type: 'root', plugin_ids: ['move', 'up', 'fork', 'dup1', 'dup2'] },
    { id: 'cat', type: 'category', parent: 'root', plugin_ids: ['move', 'up', 'fork', 'dup1', 'dup2'] },
    { id: 'a', type: 'branch', parent: 'cat', plugin_ids: ['move', 'up', 'fork', 'dup1', 'dup2'] },
    { id: 'b', type: 'branch', parent: 'cat', plugin_ids: [] },
    ...['move', 'up', 'fork', 'dup1', 'dup2'].map((id) => ({
      id,
      type: 'plugin',
      parent: 'a',
      plugin_ids: [id],
      plugin_id: id,
    })),
  ],
  edges: ['move', 'up', 'fork', 'dup1', 'dup2'].map((id) => ({ source: 'a', target: id, type: 'parent', weight: 1 })),
};
const plugins = [
  { id: 'new', name: '新插件', branch_id: 'b' },
  { id: 'move', branch_id: 'b' },
  { id: 'up', name: 'repo', repo: 'https://github.com/a/repo', branch_id: 'a', stars: 20 },
  { id: 'fork', name: 'repo', repo: 'https://github.com/b/repo', branch_id: 'a', gh_fork: true },
  { id: 'dup1', name: 'first', branch_id: 'a', stars: 5 },
  { id: 'dup2', name: 'second', branch_id: 'a', stars: 1 },
];
const readmeHash = (p) => (p.id.startsWith('dup') ? 'same' : null);
const sha = (data) => createHash('sha256').update(data).digest('hex');

test('同名不同内容不判 fork，只有明确规则才能建立关联', () => {
  const items = [
    { id: 'a1', name: 'same', repo: 'https://github.com/a/same', description: 'first project' },
    { id: 'a2', name: 'same', repo: 'https://github.com/b/same', description: 'different project' },
    { id: 'a3', name: 'same', repo: 'https://github.com/c/same', gh_fork: true },
    { id: 'b1', repo: 'https://github.com/a/other', description: 'identical description' },
    { id: 'b2', repo: 'https://github.com/b/other', description: 'identical description' },
    { id: 'c1', repo: 'https://github.com/a/third' },
    { id: 'c2', repo: 'https://github.com/b/third' },
    { id: 'alone', repo: 'https://github.com/a/alone', gh_fork: true },
  ];
  const patch = planTreeSync({
    graph: { nodes: [] },
    plugins: items,
    readmeHash: (p) => ({ a1: 'one', a2: 'two', c1: 'same', c2: 'same' })[p.id],
  });
  const groups = patch.ops.fork;
  // The independent same-name repositories must not be linked to each other,
  // even though the declared fork is linked to an eligible upstream.
  const independent = planTreeSync({ graph: { nodes: [] }, plugins: items.slice(0, 2), readmeHash: (p) => p.id }).ops
    .fork;
  assert.deepEqual(independent, []);
  assert.ok(groups.some((g) => g.evidence.some((e) => e.includes('gh_fork')) && g.forks.includes('a3')));
  assert.ok(groups.some((g) => g.evidence.some((e) => e.includes('description')) && g.forks.includes('b2')));
  assert.ok(groups.some((g) => g.evidence.some((e) => e.includes('全文哈希')) && g.forks.includes('c2')));
  assert.ok(!groups.some((g) => g.forks.includes('alone')));
});

test('规划、应用和回滚树补丁，增量无变化', async () => {
  const patch = planTreeSync({ graph, plugins, readmeHash });
  assert.ok(patch.ops.attach.some((x) => x.id === 'new' && x.to === 'b'));
  assert.ok(patch.ops.move.some((x) => x.id === 'move' && x.from === 'a' && x.to === 'b'));
  assert.ok(patch.ops.fork.some((x) => x.upstream === 'up' && x.forks.includes('fork')));
  assert.ok(patch.ops.duplicate.some((x) => x.keep === 'dup1' && x.duplicates.includes('dup2')));
  const second = planTreeSync({ graph, plugins, readmeHash, previousFingerprints: patch.fingerprints });
  assert.deepEqual(second.changed, { added: [], updated: [], removed: [] });
  assert.deepEqual(second.counts, { attach: 0, move: 0, fork: 0, duplicate: 0 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusion-'));
  try {
    const dataDir = path.join(root, 'data'),
      stateDir = path.join(root, 'state');
    await fs.mkdir(dataDir);
    const original = JSON.stringify(graph);
    await fs.writeFile(path.join(dataDir, 'graph.json'), original);
    await assert.rejects(applyTreePatch({ dataDir, stateDir, patch, productionDataDir: dataDir }), /拒绝写入生产数据/);
    const result = await applyTreePatch({ dataDir, stateDir, patch });
    assert.equal(sha(await fs.readFile(result.backup)), sha(original));
    const updated = JSON.parse(await fs.readFile(path.join(dataDir, 'graph.json')));
    const node = (id) => updated.nodes.find((n) => n.id === id);
    assert.ok(node('b').plugin_ids.includes('new') && node('b').plugin_ids.includes('move'));
    assert.ok(!node('a').plugin_ids.includes('move') && node('root').plugin_ids.includes('move'));
    assert.equal(node('new').parent, 'b');
    assert.ok(updated.edges.some((e) => e.source === 'b' && e.target === 'new'));
    assert.equal(node('fork').fork_of, 'up');
    assert.equal(node('dup2').duplicate_of, 'dup1');
    assert.equal((await treeHistory(stateDir)).length, 1);
    await rollbackTree({ dataDir, stateDir });
    assert.equal(sha(await fs.readFile(path.join(dataDir, 'graph.json'))), sha(original));
    assert.equal((await treeHistory(stateDir)).length, 2);
    assert.ok((await savePatch(stateDir, patch)).includes('patch-'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
