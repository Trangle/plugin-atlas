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
        plus: 2,
        minus: 1,
        plusCaps: ['ui'],
        minusCaps: ['old'],
        unique: ['new-cap'],
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
  assert.match(container.innerHTML, /new-cap/);
  assert.match(container.innerHTML, /已折叠 12/);
  assert.match(container.innerHTML, /主干/);
  const buttons = container.querySelectorAll('[data-id]');
  assert.ok(buttons.length >= 1);
});
