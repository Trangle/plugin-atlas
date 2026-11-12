import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildTree } from '../lib/tree/caps.mjs';
import { buildBranchGraph, pluginTime } from '../lib/tree/branch-graph.mjs';

function assertLayout(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const expected = [],
    placed = new Set();
  const place = (node) => {
    if (placed.has(node.id)) return;
    if (node.attach) {
      assert.ok(byId.get(node.attach).row < node.row);
      place(byId.get(node.attach));
    }
    placed.add(node.id);
    expected.push(node.id);
  };
  for (const node of [...graph.nodes].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) place(node);
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    expected,
  );
  for (const edge of graph.edges) {
    assert.ok(edge.toRow > edge.fromRow);
    assert.ok(edge.fromLane === edge.toLane || edge.toRow === edge.fromRow + 1);
  }
}

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
  assert.equal(p2.lane, p1.lane);
  assert.equal(p2.role, 'subfork');
  assert.equal(p3.lane, p1.lane);
  assert.equal(graph.lanes, 2);
  assert.equal(p3.status, 'duplicate');
  assert.equal(p3.parent, 'P0');
  assert.deepEqual(p1.plusCaps, ['D']);
  assert.deepEqual(p1.minusCaps, ['C']);
  assert.ok(!graph.edges.some((e) => e.from === 'P1' && e.to === 'P0' && e.type === 'merge-suggest'));
  assertLayout(graph);
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
  assertLayout(graph);
  assert.ok(graph.truncated);
  assert.ok(graph.nodes.length <= 12);
  assert.ok(graph.nodes.some((n) => n.role === 'collapsed'));
  assert.ok(graph.lanes <= 12);
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
  assert.equal(graph.nodes.length, 4);
  for (const node of graph.nodes.filter((n) => n.role === 'collapsed')) {
    const label = node.clusterLabel.replaceAll(' · ', '·');
    assert.equal(node.label, `+${node.count} · ${label} 簇`);
  }
  assert.ok(graph.lanes <= 12);
  for (const rep of reps) {
    assert.equal(rep.baseline, rep.id);
    assert.deepEqual(rep.plusCaps, []);
    assert.deepEqual(rep.minusCaps, []);
  }
  const cluster = graph.clusters.find((c) => c.representative === 'C0');
  const partial = buildBranchGraph(index, family, { expandClusters: [cluster.id] });
  assertLayout(graph);
  assertLayout(full);
  assertLayout(partial);
  const group = partial.nodes.filter((n) => n.cluster === cluster.id);
  assert.equal(group.length, cluster.size);
  assert.ok(group.every((n, i) => n.lane === group[0].lane && (!i || n.row > group[i - 1].row)));
  assert.equal(partial.nodes.length, cluster.size + 2);
  for (const e of partial.edges) assert.ok(Math.abs(e.fromRow - e.toRow) === 1 || e.fromLane === e.toLane);
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

test('折叠簇按时间交错并保持并行泳道', () => {
  const plugins = ['alpha', 'beta', 'gamma'].flatMap((cap, group) =>
    [0, 1, 2].map((i) => ({
      id: `${cap}${i}`,
      capabilities: [cap],
      stars: i === 0 ? 100 : 0,
      created_at: new Date(Date.UTC(2020, 0, [group === 0 ? 4 : 1 + group, 5 + group, 12 - group][i])).toISOString(),
    })),
  );
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'branch', type: 'branch', plugin_ids: plugins.map((p) => p.id) },
        ...plugins.map((p) => ({ id: p.id, type: 'plugin', parent: 'branch' })),
      ],
    },
    plugins,
  });
  const family = { id: 'interleaved', branch: 'branch', members: plugins.map((p) => p.id) };
  const graph = buildBranchGraph(index, family);
  assert.equal(graph.clusters.length, 3);
  assert.equal(graph.nodes.filter((n) => n.role === 'collapsed').length, 3);
  for (const cluster of graph.clusters) {
    assert.ok(graph.nodes.some((n) => n.id === cluster.representative));
    assert.ok(graph.nodes.some((n) => n.role === 'collapsed' && n.cluster === cluster.id && n.count === 2));
  }
  assert.ok(
    graph.nodes.some(
      (n) =>
        Array.from({ length: graph.lanes }, (_, lane) => {
          const rows = graph.nodes.filter((x) => x.lane === lane).map((x) => x.row);
          return rows.length && Math.min(...rows) <= n.row && n.row <= Math.max(...rows);
        }).filter(Boolean).length >= 3,
    ),
  );
  assertLayout(graph);
  for (const e of graph.edges) assert.ok(e.fromLane === e.toLane || Math.abs(e.fromRow - e.toRow) === 1);
  const cluster = graph.clusters.find((c) => c.representative === 'alpha0');
  const expanded = buildBranchGraph(index, family, { expandClusters: [cluster.id] });
  assertLayout(expanded);
  const group = expanded.nodes.filter((n) => n.cluster === cluster.id);
  assert.deepEqual(
    group.map((n) => n.id),
    ['alpha0', 'alpha1', 'alpha2'],
  );
  assert.ok(group.every((n) => n.lane === group[0].lane));
  assert.ok(expanded.nodes.some((n) => n.cluster !== cluster.id && n.row > group[0].row && n.row < group[2].row));
});

test('按分叉顺序分配并复用泳道，减少斜线交叉', () => {
  const groups = [
    ['trunk', 8, 1, 20],
    ['early', 2, 2, 5],
    ['middle', 4, 3, 12],
    ['late', 6, 7, 15],
  ];
  const plugins = groups.flatMap(([cap, size, start, end]) =>
    Array.from({ length: size }, (_, i) => ({
      id: `${cap}${i}`,
      capabilities: [cap],
      stars: i === 0 ? 100 : 0,
      created_at: new Date(Date.UTC(2020, 0, i === 0 ? start : end)).toISOString(),
    })),
  );
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'branch', type: 'branch', plugin_ids: plugins.map((p) => p.id) },
        ...plugins.map((p) => ({ id: p.id, type: 'plugin', parent: 'branch' })),
      ],
    },
    plugins,
  });
  const graph = buildBranchGraph(index, { id: 'fixture', branch: 'branch', members: plugins.map((p) => p.id) });
  assertLayout(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const crossing = (edges) =>
    edges.reduce(
      (sum, edge) =>
        sum + (edge.toRow === edge.fromRow + 1 ? Math.max(0, Math.abs(edge.toLane - edge.fromLane) - 1) : 0),
      0,
    );
  let nextLane = 1;
  const oldLanes = new Map(
    graph.clusters.map((cluster) => [cluster.id, cluster.id === byId.get(graph.trunk).cluster ? 0 : nextLane++]),
  );
  const oldEdges = graph.edges.map((edge) => ({
    ...edge,
    fromLane: oldLanes.get(byId.get(edge.from).cluster),
    toLane:
      edge.fromLane === edge.toLane
        ? oldLanes.get(byId.get(edge.from).cluster)
        : oldLanes.get(byId.get(edge.to).cluster),
  }));
  const current = crossing(graph.edges),
    previous = crossing(oldEdges);
  assert.ok(current < previous, `new ${current}, r12 ${previous}`);
  assert.equal(byId.get('early0').lane, 1);
  assert.ok(byId.get('collapsed:cluster:' + byId.get('early0').cluster).row < byId.get('late0').row);
  assert.equal(byId.get('late0').lane, 1);
  console.log(`lane traversal crossings: r12=${previous}, new=${current}`);
});
