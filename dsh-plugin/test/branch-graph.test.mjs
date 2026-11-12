import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildTree } from '../lib/tree/caps.mjs';
import { buildBranchGraph, pluginTime } from '../lib/tree/branch-graph.mjs';

function fixture(extra = 0) {
  const plugins = [
    { id: 'P0', capabilities: ['A', 'B', 'C'], created_at: '2020-01-01', stars: 10 },
    { id: 'P1', capabilities: ['A', 'B', 'D'], created_at: '2020-01-02' },
    { id: 'P2', capabilities: ['D', 'E'], created_at: '2020-01-03' },
    { id: 'P3', capabilities: ['A'], created_at: '2020-01-04' },
    ...Array.from({ length: extra }, (_, i) => ({ id: `X${String(i).padStart(3, '0')}`, created_at: '2020-02-01' })),
  ];
  const nodes = [
    { id: 'branch', type: 'branch', plugin_ids: plugins.map((p) => p.id) },
    ...plugins.map((p) => ({
      id: p.id,
      type: 'plugin',
      parent: 'branch',
      ...(p.id === 'P2' ? { fork_of: 'P1' } : {}),
      ...(p.id === 'P3' ? { duplicate_of: 'P0' } : {}),
    })),
  ];
  return {
    index: buildTree({ graph: { nodes }, plugins }),
    family: { id: 'branch', branch: 'branch', members: plugins.map((p) => p.id) },
    fusion: { ops: { fork: [{ upstream: 'P0', forks: ['P1'] }] } },
    plan: { base: 'P0', absorb: [{ from: 'P1', capabilities: ['D'] }] },
  };
}

test('分叉、重复、能力差异和合并建议', () => {
  const { index, family, fusion, plan } = fixture();
  const graph = buildBranchGraph(index, family, { fusion, plan });
  const [p0, p1, p2, p3] = ['P0', 'P1', 'P2', 'P3'].map((id) => graph.nodes.find((n) => n.id === id));
  assert.equal(p0.lane, 0);
  assert.equal(p0.role, 'trunk');
  assert.notEqual(p1.lane, p0.lane);
  assert.equal(p2.parent, 'P1');
  assert.notEqual(p2.lane, p1.lane);
  assert.equal(p2.role, 'subfork');
  assert.notEqual(p3.lane, p1.lane);
  assert.equal(p3.status, 'duplicate');
  assert.equal(p3.parent, 'P0');
  assert.deepEqual(p1.plusCaps, ['D']);
  assert.deepEqual(p1.minusCaps, ['C']);
  assert.ok(graph.edges.some((e) => e.from === 'P1' && e.to === 'P0' && e.type === 'merge-suggest'));
  assert.deepEqual(
    graph.nodes.map((n) => n.row),
    [0, 1, 2, 3],
  );
  for (const n of graph.nodes) {
    const seen = new Set();
    let current = n;
    while (current?.parent) {
      assert.ok(!seen.has(current.id));
      seen.add(current.id);
      current = graph.nodes.find((x) => x.id === current.parent);
    }
  }
  assert.equal(pluginTime({ created_at: 'invalid', pushed_at: '2020-01-01' }), Date.parse('2020-01-01'));
});

test('折叠并展开大族', () => {
  const { index, family, fusion, plan } = fixture(50);
  const graph = buildBranchGraph(index, family, { fusion, plan, limit: 12 });
  assert.ok(graph.truncated);
  assert.ok(graph.nodes.length <= 12);
  assert.ok(graph.nodes.some((n) => n.role === 'collapsed'));
  assert.equal(buildBranchGraph(index, family, { fusion, plan, expand: true }).nodes.length, 54);
});

test('399 成员性能', () => {
  const { index, family, fusion, plan } = fixture(395);
  let start = performance.now();
  buildBranchGraph(index, family, { fusion, plan });
  assert.ok(performance.now() - start < 200);
  start = performance.now();
  buildBranchGraph(index, family, { fusion, plan, expand: true });
  assert.ok(performance.now() - start < 1000);
});

test('能力族按子能力聚类、按簇折叠并相对代表比较', () => {
  const plugins = Array.from({ length: 20 }, (_, i) => ({
    id: `C${i}`,
    capabilities: ['shared', i < 10 ? 'alpha' : 'beta', ...(i === 1 ? ['extra'] : [])],
    stars: i === 0 || i === 10 ? 100 : 0,
  }));
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'branch', type: 'branch', plugin_ids: plugins.map((p) => p.id) },
        ...plugins.map((p) => ({ id: p.id, type: 'plugin', parent: 'branch' })),
      ],
    },
    plugins,
  });
  const family = { id: 'ui.layout.sidebar', branch: 'branch', members: plugins.map((p) => p.id) };
  const graph = buildBranchGraph(index, family, { limit: 6 });
  assert.equal(graph.kind, 'capability');
  assert.equal(graph.clusters.length, 2);
  const reps = graph.clusters.map((c) => graph.nodes.find((n) => n.id === c.representative));
  assert.notEqual(reps[0].lane, reps[1].lane);
  const full = buildBranchGraph(index, family, { expand: true });
  const member = full.nodes.find((n) => n.id === 'C1');
  assert.equal(member.baseline, 'C0');
  assert.deepEqual(member.plusCaps, ['extra']);
  assert.deepEqual(member.minusCaps, []);
  const collapsed = graph.nodes.filter((n) => n.role === 'collapsed');
  assert.equal(collapsed.length, 2);
  for (const node of collapsed) {
    assert.match(node.id, /^collapsed:cluster:/);
    assert.ok(node.label.includes(node.clusterLabel));
    assert.equal(node.parent, graph.clusters.find((c) => c.id === node.cluster).representative);
  }
});

test('空能力插件按名称词聚类，避免全部落入其他', () => {
  const plugins = [
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `W${i}`,
      name: `dsh-workspace-group-${i}`,
      summary: '从侧边栏打开工作区文件夹',
      created_at: '2021-01-01',
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `S${i}`,
      name: `dsh-session-list-${i}`,
      summary: '管理会话列表与置顶',
      created_at: '2021-02-01',
    })),
  ];
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'branch', type: 'branch', plugin_ids: plugins.map((p) => p.id) },
        ...plugins.map((p) => ({ id: p.id, type: 'plugin', parent: 'branch' })),
      ],
    },
    plugins,
  });
  const family = { id: 'ui.layout.sidebar', branch: 'branch', members: plugins.map((p) => p.id) };
  const graph = buildBranchGraph(index, family, { expand: true });
  assert.equal(graph.kind, 'capability');
  assert.ok(graph.clusters.length >= 2);
  const other = graph.clusters.find((c) => c.label === '其他');
  assert.ok(!other || other.size < plugins.length / 2);
  const clusterOf = (id) => graph.nodes.find((n) => n.id === id).cluster;
  assert.notEqual(clusterOf('W0'), clusterOf('S0'));
  assert.equal(clusterOf('W1'), clusterOf('W0'));
  assert.equal(clusterOf('S1'), clusterOf('S0'));
});
