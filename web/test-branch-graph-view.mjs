import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBranchGraph, dateLabel } from './public/branch-graph-view.js';

test('dateLabel formats local dates and empty values', () => {
  assert.equal(dateLabel(0), '');
  assert.equal(dateLabel(undefined), '');
  assert.match(dateLabel(Date.UTC(2024, 0, 2, 0, 0, 0)), /^\d{4}-\d{2}-\d{2}$/);
});

test('renderBranchGraph draws trunk, fork, merge-suggest, diffs and unique caps', () => {
  const clicks = [];
  const container = {
    innerHTML: '',
    querySelectorAll(sel) {
      const ids = [...this.innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
      const uniq = [...new Set(ids)];
      return uniq.map((id) => ({
        getAttribute: () => id,
        addEventListener: (type, fn) => {
          if (type === 'click') this._fns ? this._fns.push(fn) : (this._click = fn);
        },
      }));
    },
  };
  const graph = {
    family: 'demo',
    trunk: 'p0',
    lanes: 2,
    rows: 3,
    truncated: true,
    hidden: 12,
    nodes: [
      { id: 'p0', label: 'Trunk', role: 'trunk', status: 'active', lane: 0, row: 0, time: Date.UTC(2024, 0, 1) },
      {
        id: 'p1',
        label: 'Fork',
        role: 'fork',
        status: 'active',
        lane: 1,
        row: 1,
        time: Date.UTC(2024, 5, 1),
        baseline: 'p0',
        baselineLabel: 'Trunk',
        plus: 2,
        minus: 1,
        plusCaps: ['ui'],
        minusCaps: ['old'],
        unique: ['new-cap', 'second', 'third', 'fourth'],
      },
      { id: 'collapsed:p0:1', label: '另 12 个分支', role: 'collapsed', status: 'active', lane: 1, row: 2, count: 12 },
    ],
    edges: [
      { from: 'p0', to: 'p1', type: 'fork' },
      { from: 'p1', to: 'p0', type: 'merge-suggest' },
    ],
  };
  renderBranchGraph(container, graph, { onSelect: (id) => clicks.push(id) });
  assert.match(container.innerHTML, /bg-track trunk/);
  assert.match(container.innerHTML, /bg-edge fork/);
  assert.match(container.innerHTML, /bg-edge merge-suggest/);
  assert.match(container.innerHTML, /\+2/);
  assert.match(container.innerHTML, /−1/);
  assert.match(container.innerHTML, /title="对比：Trunk"/);
  assert.match(container.innerHTML, /class="bg-edge merge-suggest" d="M [^"]* C /);
  assert.match(container.innerHTML, /new-cap/);
  assert.match(container.innerHTML, /已折叠 12/);
  assert.match(container.innerHTML, /主干/);
  const buttons = container.querySelectorAll('[data-id]');
  assert.ok(buttons.length >= 1);
});

test('标签最多显示两个，窄侧栏可隐藏标签', () => {
  const container = { innerHTML: '', querySelectorAll: () => [] };
  const graph = {
    family: 'x',
    lanes: 1,
    rows: 1,
    edges: [],
    nodes: [{ id: 'a', role: 'trunk', row: 0, lane: 0, unique: ['one', 'two', 'three', 'four'] }],
  };
  renderBranchGraph(container, graph);
  assert.equal((container.innerHTML.match(/class="bg-cap"/g) || []).length, 2);
  assert.match(container.innerHTML, /class="bg-more"[^>]*>\+2/);
  renderBranchGraph(container, graph, { hideTags: true });
  assert.doesNotMatch(container.innerHTML, /bg-cap|bg-more/);
});

test('圆点与标签行中心及固定泳道对齐', () => {
  const container = { innerHTML: '', clientWidth: 1800, querySelectorAll: () => [], querySelector: () => null };
  const nodes = Array.from({ length: 3 }, (_, row) => ({
    id: `n${row}`,
    role: row ? 'fork' : 'trunk',
    lane: row,
    row,
  }));
  renderBranchGraph(container, { family: 'geometry', nodes, edges: [], lanes: 3, rows: 3 });
  const circles = [...container.innerHTML.matchAll(/<circle[^>]*data-id="([^"]+)"[^>]*cx="([\d.]+)" cy="([\d.]+)"/g)];
  const labels = [
    ...container.innerHTML.matchAll(
      /<div class="bg-label[^>]*data-id="([^"]+)" style="left:([\d.]+)px;top:([\d.]+)px;right:[\d.]+px;height:([\d.]+)px"/g,
    ),
  ];
  assert.equal(circles.length, 3);
  assert.equal(labels.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(circles[i][1], labels[i][1]);
    assert.ok(Math.abs(Number(circles[i][3]) - (Number(labels[i][3]) + Number(labels[i][4]) / 2)) <= 1);
    assert.equal(Number(circles[i][2]), 20 + i * 16 + 8);
    assert.equal(Number(labels[i][2]), 20 + 3 * 16 + 8);
  }
});

test('跨泳道采用平滑三次曲线且主干轨道止于末节点', () => {
  const container = { innerHTML: '', querySelectorAll: () => [] };
  const nodes = [
    { id: 'a', lane: 0, row: 0, role: 'trunk' },
    { id: 'b', lane: 2, row: 1, role: 'fork' },
    { id: 'c', lane: 0, row: 2, role: 'fork' },
  ];
  renderBranchGraph(container, {
    family: 'x',
    nodes,
    lanes: 3,
    rows: 4,
    edges: [{ from: 'a', to: 'b', type: 'fork' }],
  });
  assert.match(container.innerHTML, /d="M 28 38 C 28 56, 60 56, 60 74"/);
  assert.doesNotMatch(container.innerHTML, /d="M 28 38 [^"]* L /);
  assert.match(container.innerHTML, /bg-track trunk" x1="28" y1="38" x2="28" y2="110"/);
});
